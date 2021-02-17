import {
  execute as defaultExecute,
  getOperationAST,
  parse as defaultParse,
  subscribe as defaultSubscribe,
  validate as defaultValidate,
  DocumentNode,
  GraphQLError,
  GraphQLSchema,
  OperationDefinitionNode,
  ValidationRule,
  ExecutionResult,
} from "graphql";
import { stopAsyncIteration, isAsyncIterable, isHttpMethod } from "./util";
import { HttpError } from "./errors";
import {
  ExecutionPatchResult,
  MultipartResponse,
  ProcessRequestOptions,
  ProcessRequestResult,
} from "./types";

const parseQuery = (
  query: string | DocumentNode,
  parse: typeof defaultParse
): DocumentNode => {
  if (typeof query !== "string" && query.kind === "Document") {
    return query;
  }
  try {
    return parse(query as string);
  } catch (syntaxError) {
    throw new HttpError(400, "GraphQL syntax error.", {
      graphqlErrors: [syntaxError],
    });
  }
};

export const validateDocument = (
  schema: GraphQLSchema,
  document: DocumentNode,
  validate: typeof defaultValidate,
  validationRules?: readonly ValidationRule[]
): void => {
  const validationErrors = validate(schema, document, validationRules);
  if (validationErrors.length) {
    throw new HttpError(400, "GraphQL validation error.", {
      graphqlErrors: validationErrors,
    });
  }
};

const getExecutableOperation = (
  document: DocumentNode,
  operationName?: string,
  getOperationAstFn: typeof getOperationAST = getOperationAST
): OperationDefinitionNode => {
  const operation = getOperationAstFn(document, operationName);

  if (!operation) {
    throw new HttpError(400, "Could not determine what operation to execute.");
  }

  return operation;
};

const defaultVariablesParser = (
  variables: string | { [name: string]: any } | undefined
) =>
  variables
    ? typeof variables === "string"
      ? JSON.parse(variables)
      : variables
    : undefined;

const parseVariables = (
  variables: string | { [name: string]: any } | undefined,
  variablesFactoryFn = defaultVariablesParser
) => {
  try {
    return variablesFactoryFn(variables);
  } catch (_error) {
    throw new HttpError(400, "Variables are invalid JSON.");
  }
};

export const processRequest = async <TContext = {}, TRootValue = {}>(
  options: ProcessRequestOptions<TContext, TRootValue>
): Promise<ProcessRequestResult<TContext, TRootValue>> => {
  const {
    contextFactory,
    execute = defaultExecute,
    formatPayload = ({ payload }) => payload,
    operationName,
    parse = defaultParse,
    query,
    request,
    rootValueFactory,
    schema,
    subscribe = defaultSubscribe,
    validate = defaultValidate,
    validationRules,
    variables,
    getOperationAstFn,
    variablesFactory,
  } = options;

  let context: TContext | undefined;
  let rootValue: TRootValue | undefined;
  let document: DocumentNode | undefined;
  let operation: OperationDefinitionNode | undefined;

  const result = await (async (): Promise<
    ProcessRequestResult<TContext, TRootValue>
  > => {
    const accept =
      typeof request.headers.get === "function"
        ? request.headers.get("accept")
        : (request.headers as any).accept;
    const isEventStream = accept === "text/event-stream";

    try {
      if (
        !isHttpMethod("GET", request.method) &&
        !isHttpMethod("POST", request.method)
      ) {
        throw new HttpError(
          405,
          "GraphQL only supports GET and POST requests.",
          {
            headers: [{ name: "Allow", value: "GET, POST" }],
          }
        );
      }

      if (query == null) {
        throw new HttpError(400, "Must provide query string.");
      }

      document = parseQuery(query, parse);

      validateDocument(schema, document, validate, validationRules);

      operation = getExecutableOperation(
        document,
        operationName,
        getOperationAstFn
      );

      if (
        operation.operation === "mutation" &&
        isHttpMethod("GET", request.method)
      ) {
        throw new HttpError(
          405,
          "Can only perform a mutation operation from a POST request.",
          { headers: [{ name: "Allow", value: "POST" }] }
        );
      }

      let variableValues: { [name: string]: any } | undefined = parseVariables(
        variables,
        variablesFactory
      );

      try {
        const executionContext = {
          document,
          operation,
          variables: variableValues,
        };
        context = contextFactory
          ? await contextFactory(executionContext)
          : ({} as TContext);
        rootValue = rootValueFactory
          ? await rootValueFactory(executionContext)
          : ({} as TRootValue);

        if (operation.operation === "subscription") {
          const result = await subscribe(
            schema,
            document,
            rootValue,
            context,
            variableValues,
            operationName
          );

          // If errors are encountered while subscribing to the operation, an execution result
          // instead of an AsyncIterable.
          if (isAsyncIterable<ExecutionResult>(result)) {
            return {
              type: "PUSH",
              subscribe: async (onResult) => {
                for await (const payload of result) {
                  onResult(
                    formatPayload({
                      payload,
                      context,
                      rootValue,
                      document,
                      operation,
                    })
                  );
                }
              },
              unsubscribe: () => {
                stopAsyncIteration(result);
              },
            };
          } else {
            if (isEventStream) {
              return {
                type: "PUSH",
                subscribe: async (onResult) => {
                  onResult(
                    formatPayload({
                      payload: result,
                      context,
                      rootValue,
                      document,
                      operation,
                    })
                  );
                },
                unsubscribe: () => undefined,
              };
            } else {
              return {
                type: "RESPONSE",
                payload: formatPayload({
                  payload: result,
                  context,
                  rootValue,
                  document,
                  operation,
                }),
                status: 200,
                headers: [],
              };
            }
          }
        } else {
          const result = await execute(
            schema,
            document,
            rootValue,
            context,
            variableValues,
            operationName
          );

          // Operations that use @defer, @stream and @live will return an `AsyncIterable` instead of an
          // execution result.
          if (isAsyncIterable<ExecutionPatchResult>(result)) {
            return {
              type: isEventStream ? "PUSH" : "MULTIPART_RESPONSE",
              subscribe: async (onResult) => {
                for await (const payload of result) {
                  onResult(
                    formatPayload({
                      payload,
                      context,
                      rootValue,
                      document,
                      operation,
                    })
                  );
                }
              },
              unsubscribe: () => {
                stopAsyncIteration(result);
              },
            } as MultipartResponse<TContext, TRootValue>;
          } else {
            return {
              type: "RESPONSE",
              status: 200,
              headers: [],
              payload: formatPayload({
                payload: result,
                context,
                rootValue,
                document,
                operation,
              }),
            };
          }
        }
      } catch (executionError) {
        throw new HttpError(
          500,
          "Unexpected error encountered while executing GraphQL request.",
          {
            graphqlErrors: [new GraphQLError(executionError.message)],
          }
        );
      }
    } catch (error) {
      const payload = {
        errors: error.graphqlErrors || [new GraphQLError(error.message)],
      };
      if (isEventStream) {
        return {
          type: "PUSH",
          subscribe: async (onResult) => {
            onResult(
              formatPayload({
                payload,
                context,
                rootValue,
                document,
                operation,
              })
            );
          },
          unsubscribe: () => undefined,
        };
      } else {
        return {
          type: "RESPONSE",
          status: error.status || 500,
          headers: error.headers || [],
          payload: formatPayload({
            payload,
            context,
            rootValue,
            document,
            operation,
          }),
        };
      }
    }
  })();

  return {
    ...result,
    context,
    rootValue,
    document,
    operation,
  };
};

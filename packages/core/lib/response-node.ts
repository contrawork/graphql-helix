import type { ServerResponse } from "http";
import type { Http2ServerResponse } from "http2";
import { HttpError } from "./errors";
import type {
  Response,
  MultipartResponse,
  Push,
  ProcessRequestResult,
} from "./types";

type RawResponse = ServerResponse | Http2ServerResponse;

export async function sendResponseResult(
  responseResult: Response<any, any>,
  rawResponse: RawResponse
) {
  rawResponse.statusCode = responseResult.status;
  rawResponse.end(JSON.stringify(responseResult.payload));
}

export async function sendMultipartResponseResult(
  multipartResult: MultipartResponse<any, any>,
  rawResponse: RawResponse
) {
  rawResponse.writeHead(200, {
    // prettier-ignore
    "Connection": "keep-alive",
    "Content-Type": 'multipart/mixed; boundary="-"',
    "Transfer-Encoding": "chunked",
  });

  rawResponse.on("close", () => {
    multipartResult.unsubscribe();
  });
  // @ts-ignore - Different Signature between ServerResponse and Http2ServerResponse but still compatible.
  rawResponse.write("---");

  await multipartResult.subscribe((result) => {
    const chunk = Buffer.from(JSON.stringify(result), "utf8");
    const data = [
      "",
      "Content-Type: application/json; charset=utf-8",
      "Content-Length: " + String(chunk.length),
      "",
      chunk,
    ];

    if (result.hasNext) {
      data.push("---");
    }
    // @ts-ignore - Different Signature between ServerResponse and Http2ServerResponse but still compatible.
    rawResponse.write(data.join("\r\n"));
  });

  // @ts-ignore - Different Signature between ServerResponse and Http2ServerResponse but still compatible.
  rawResponse.write("\r\n-----\r\n");
  rawResponse.end();
}

export async function sendPushResult(
  pushResult: Push<any, any>,
  rawResponse: RawResponse
) {
  rawResponse.writeHead(200, {
    "Content-Type": "text/event-stream",
    // prettier-ignore
    "Connection": "keep-alive",
    "Cache-Control": "no-cache",
  });

  rawResponse.on("close", () => {
    pushResult.unsubscribe();
  });

  await pushResult.subscribe((result) => {
    // @ts-ignore - Different Signature between ServerResponse and Http2ServerResponse but still compatible.
    rawResponse.write(`data: ${JSON.stringify(result)}\n\n`);
  });
}

export async function sendResult(
  result: ProcessRequestResult<any, any>,
  rawResponse: RawResponse
) {
  if (result.type === "RESPONSE") {
    return sendResponseResult(result, rawResponse);
  } else if (result.type === "MULTIPART_RESPONSE") {
    return sendMultipartResponseResult(result, rawResponse);
  } else if (result.type === "PUSH") {
    return sendPushResult(result, rawResponse);
  }
  throw new HttpError(500, "Cannot process result.");
}

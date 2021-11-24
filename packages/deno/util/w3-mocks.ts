import { isAsyncIterable } from "./is-async-iterable.ts";

type Callback<T> = (result: ReadableStreamDefaultReadResult<T> ) => void;

export const ReadableStream = globalThis.ReadableStream || class ReadableStreamPonyfill<T> {
    constructor(private source: UnderlyingSource<T>) {}

    getReader() {
        let listening = true;
        const pullQueue: Callback<T>[] = [];
        const pushQueue: ReadableStreamDefaultReadResult<T>[] = [];

        const pushValue = (value: T) => {
            if (pullQueue.length !== 0) {
                pullQueue.shift()!({ value, done: false } as const);
            } else {
                pushQueue.push({ value, done: false });
            }
        };

        const pushDone = () => {
            if (pullQueue.length !== 0) {
                pullQueue.shift()!({ value: undefined, done: true } as const);
            } else {
                pushQueue.push({ value: undefined, done: true } as const);
            }
        };

        const pullValue = () =>
            new Promise<ReadableStreamDefaultReadResult<T>>(resolve => {
                if (pushQueue.length !== 0) {
                    const element = pushQueue.shift()!;
                    resolve(element);
                } else {
                    pullQueue.push(resolve);
                }
            });

        const emptyQueue = () => {
            if (listening) {
                listening = false;
                for (const resolve of pullQueue) {
                    resolve({ value: undefined, done: true } as const);
                }
                pullQueue.length = 0;
                pushQueue.length = 0;
            }
            return Promise.resolve({ value: undefined, done: true } as const);
        };

        const controller = {
            desiredSize: Infinity,
            error: () => {
            },
            enqueue: (value: T) => {
                pushValue(value);
            },
            close: () => {
                pushDone();
            }
        };
        this.source.start?.(controller);
        return {
            async read() {
                return listening ? pullValue() : emptyQueue();
            },
            releaseLock: () => {
                emptyQueue();
                this.source.cancel?.(controller);
            },
            cancel: async () => {
                emptyQueue();
                this.source.cancel?.(controller);
            },
            closed: Promise.resolve(undefined),
        }
    }
} as unknown as typeof globalThis['ReadableStream'];

class BodyPonyfill {
    private body: ReadableStream | null = null;
    constructor(source?: ReadableStream | string) {
        if (source != null) {
            if (typeof source === "string") {
                this.body = new ReadableStream({
                    start(controller) {
                        controller.enqueue(source);
                        controller.close();
                    }
                });
            } else if(isAsyncIterable(source)) {
                this.body = new ReadableStream({
                    start(controller) {
                        for (const chunk of source as any) {
                            controller.enqueue(chunk);
                        }
                        controller.close();
                    }
                });
            } else if ('getReader' in source) {
                this.body = source;
            }
        }
    }

    async text() {
        if (this.body != null) {
            const reader = this.body.getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                chunks.push(value);
            }
            return chunks.join("");
        }
        return null;
    }

    async json() {
        const text = await this.text();
        if (text) {
            return JSON.parse(text);
        }
    }
}

export const Request =
    globalThis.Request ||
    class Request extends BodyPonyfill {
        constructor(
            public url: string,
            private init?: {
                headers?: Record<string, string>;
                method?: string;
                body?: ReadableStream | string;
            }
        ) {
            super(init?.body);
        }

        get headers() {
            return {
                get: (name: string) => {
                    return this.init?.headers?.[name];
                },
                forEach: (fn: (value: string | undefined, name: string) => void) => {
                    const headersObj = this.init?.headers || {};
                    for (const key in headersObj) {
                        fn(headersObj[key], key);
                    }
                },
            };
        }

        get method() {
            return this.init?.method ?? "GET";
        }
    } as unknown as typeof globalThis['Request'];

export const Response =
    globalThis.Response ||
    class Response extends BodyPonyfill {
        constructor(
            source: ReadableStream | string,
            private init?: {
                headers: Record<string, string>;
                status?: number;
            }
        ) {
            super(source);
        }

        get headers() {
            return {
                get: (name: string) => {
                    return this.init?.headers?.[name];
                },
                forEach: (fn: (value: string | undefined, name: string) => void) => {
                    const headersObj = this.init?.headers || {};
                    for (const key in headersObj) {
                        fn(headersObj[key], key);
                    }
                },
            };
        }

        get status() {
            return this.init?.status ?? 200;
        }
    } as unknown as typeof globalThis['Response'];

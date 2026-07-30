/**
 * HTTP tests without a server.
 *
 * `app.request(...)` runs the whole Hono pipeline -- validation, middleware,
 * handler, error handler -- against a Web `Request` object and returns a Web
 * `Response`. No port is bound and nothing is asynchronous about setup. It is
 * FastAPI's `TestClient` with less machinery underneath.
 */

import type { Storage } from "@agent/core";
import type { Logger } from "@agent/observability";
import type { AgentEvent, Env } from "@agent/schemas";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";

const env = {
    NODE_ENV: "test",
    PORT: 8080,
    OPENAI_BASE_URL: "http://localhost:8000/v1",
    OPENAI_API_KEY: "test",
    AGENT_MODEL: "test-model",
    LOG_LEVEL: "error",
} as Env;

/** A logger that records nothing. `vi.fn()` is `unittest.mock.Mock()`. */
const silentLogger = {
    child: () => silentLogger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
} as unknown as Logger;

function fakeStorage(overrides: Partial<Storage> = {}): Storage {
    return {
        createRun: vi.fn(async () => undefined),
        finishRun: vi.fn(async () => {}),
        failRun: vi.fn(async () => {}),
        getRun: vi.fn(async () => undefined),
        claimRun: vi.fn(async () => undefined),
        close: vi.fn(async () => {}),
        ...overrides,
    };
}

/** A scripted agent. The route cannot tell it from the real loop. */
function scriptedAgent(events: AgentEvent[]) {
    return async function* () {
        for (const event of events) yield event;
    };
}

/** Parse an SSE body into `{event, data}` pairs. */
function parseSSE(body: string): Array<{ event: string; data: unknown }> {
    return body
        .split("\n\n")
        .filter((block) => block.trim())
        .map((block) => {
            const lines = block.split("\n");
            const event =
                lines
                    .find((l) => l.startsWith("event:"))
                    ?.slice(6)
                    .trim() ?? "";
            const data =
                lines
                    .find((l) => l.startsWith("data:"))
                    ?.slice(5)
                    .trim() ?? "";
            return { event, data: JSON.parse(data) };
        });
}

describe("GET /healthz", () => {
    it("does not depend on the database", async () => {
        const app = createApp({
            env,
            logger: silentLogger,
            // A storage whose every call throws. The health check still passes,
            // which is the behaviour we want during a Postgres failover.
            storage: fakeStorage({
                getRun: vi.fn(async () => {
                    throw new Error("db down");
                }),
            }),
            runAgent: scriptedAgent([]),
        });

        const res = await app.request("/healthz");
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true });
    });
});

describe("POST /v1/chat", () => {
    it("rejects an empty message before reaching the model", async () => {
        const runAgent = vi.fn(scriptedAgent([]));
        const app = createApp({
            env,
            logger: silentLogger,
            storage: fakeStorage(),
            runAgent,
        });

        const res = await app.request("/v1/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "" }),
        });

        expect(res.status).toBe(400);
        expect(runAgent).not.toHaveBeenCalled();
    });

    it("streams one SSE frame per agent event", async () => {
        const app = createApp({
            env,
            logger: silentLogger,
            storage: fakeStorage(),
            runAgent: scriptedAgent([
                { type: "text", delta: "0.5" },
                { type: "text", delta: " GiB" },
                { type: "done", stopReason: "stop", steps: 1, text: "0.5 GiB" },
            ]),
        });

        const res = await app.request("/v1/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "how much VRAM?" }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const frames = parseSSE(await res.text());
        expect(frames.map((f) => f.event)).toEqual(["text", "text", "done"]);
    });

    it("persists the assembled text once, after the stream ends", async () => {
        const createRun = vi.fn(async () => undefined);
        const app = createApp({
            env,
            logger: silentLogger,
            storage: fakeStorage({ createRun }),
            runAgent: scriptedAgent([
                { type: "text", delta: "a" },
                { type: "text", delta: "b" },
                { type: "done", stopReason: "stop", steps: 1, text: "ab" },
            ]),
        });

        const res = await app.request("/v1/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hi" }),
        });

        // Reading the body is what drives the stream to completion. A streamed
        // response is lazy: `app.request` resolves as soon as the headers are
        // ready, and the generator only advances as the consumer pulls. Drop
        // this line and the assertion below sees zero calls.
        await res.text();

        expect(createRun).toHaveBeenCalledTimes(1);
        expect(createRun).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "chat", output: { text: "ab" } }),
        );
    });

    it("reports a mid-stream failure as an error frame, not a 500", async () => {
        // The response status was committed the moment the first byte went
        // out. This is the failure mode that surprises people migrating from
        // request/response handlers.
        const app = createApp({
            env,
            logger: silentLogger,
            storage: fakeStorage(),
            runAgent: async function* () {
                yield { type: "text", delta: "partial" } as AgentEvent;
                throw new Error("upstream 429");
            },
        });

        const res = await app.request("/v1/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hi" }),
        });

        expect(res.status).toBe(200);
        const frames = parseSSE(await res.text());
        expect(frames.at(-1)?.event).toBe("error");
        expect(frames.at(-1)?.data).toMatchObject({ message: "upstream 429" });
    });
});

describe("POST /v1/sweeps", () => {
    it("returns 202 with the queued run id", async () => {
        const app = createApp({
            env,
            logger: silentLogger,
            storage: fakeStorage({
                createRun: vi.fn(async () => ({ id: "run-1", status: "queued" }) as never),
            }),
            runAgent: scriptedAgent([]),
        });

        const res = await app.request("/v1/sweeps", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "qwen3-32b",
                seqLen: 8192,
                batchSizes: [1, 2, 4],
            }),
        });

        expect(res.status).toBe(202);
        await expect(res.json()).resolves.toEqual({
            id: "run-1",
            status: "queued",
        });
    });

    it("rejects a batch list longer than the ceiling", async () => {
        const app = createApp({
            env,
            logger: silentLogger,
            storage: fakeStorage(),
            runAgent: scriptedAgent([]),
        });

        const res = await app.request("/v1/sweeps", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "qwen3-32b",
                seqLen: 8192,
                batchSizes: Array.from({ length: 50 }, (_, i) => i + 1),
            }),
        });

        expect(res.status).toBe(400);
    });

    it("answers 503 rather than 202 when storage is absent", async () => {
        const app = createApp({
            env,
            logger: silentLogger,
            storage: fakeStorage(),
            runAgent: scriptedAgent([]),
        });

        const res = await app.request("/v1/sweeps", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "qwen3-32b",
                seqLen: 8192,
                batchSizes: [1],
            }),
        });

        expect(res.status).toBe(503);
    });
});

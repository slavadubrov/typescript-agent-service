/**
 * The HTTP surface, built with Hono.
 *
 * Hono is the closest thing TypeScript has to FastAPI: small, typed, and
 * built on the Web `Request`/`Response` objects rather than Node-specific
 * streams. That last property is why the same file runs unchanged on Node,
 * Cloud Run, Lambda, Deno, Bun, and Cloudflare Workers.
 *
 * `createApp` returns the app instead of starting a server. The tests call it
 * with fake dependencies and hit `app.request("/v1/chat")` directly -- no
 * port, no socket, no `httpx.AsyncClient`. That is the Hono equivalent of
 * FastAPI's `TestClient`, and it is why every dependency arrives as an
 * argument rather than being imported.
 */

import type { Storage } from "@agent/core";
import type { Logger } from "@agent/observability";
import { withSpan } from "@agent/observability";
import { type AgentEvent, ChatRequestSchema, type Env, SweepRequestSchema } from "@agent/schemas";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface AppDeps {
    env: Env;
    logger: Logger;
    storage: Storage;
    /** Injected so tests can supply a scripted agent instead of a model. */
    runAgent: (input: { message: string; maxSteps: number }) => AsyncGenerator<AgentEvent>;
}

export function createApp(deps: AppDeps) {
    const app = new Hono();

    // Liveness. Deliberately does not touch Postgres: a health check that
    // fails when the database is slow turns one degraded dependency into a
    // restart loop across every replica.
    app.get("/healthz", (c) => c.json({ ok: true }));

    /**
     * POST /v1/chat -- Server-Sent Events.
     *
     * SSE, not WebSockets. It is one-directional, it is plain HTTP, it
     * survives proxies and load balancers that mangle upgrades, and it is what
     * every LLM provider streams over. `text/event-stream` framing is three
     * fields: `event`, `data`, and an optional `id`.
     *
     * `zValidator("json", Schema)` validates the body and, more usefully,
     * types `c.req.valid("json")` as the parsed output. Skip it and the body
     * is `any`, which defeats the point of the schema.
     */
    app.post("/v1/chat", zValidator("json", ChatRequestSchema), (c) => {
        const body = c.req.valid("json");
        const log = deps.logger.child({ route: "chat" });

        return streamSSE(c, async (stream) => {
            let text = "";
            try {
                await withSpan("agent.run", { "agent.max_steps": body.maxSteps }, async () => {
                    for await (const event of deps.runAgent({
                        message: body.message,
                        maxSteps: body.maxSteps,
                    })) {
                        if (event.type === "text") text += event.delta;

                        // One SSE frame per agent event. The client switches on
                        // `event:` and never has to parse a bespoke protocol.
                        await stream.writeSSE({
                            event: event.type,
                            data: JSON.stringify(event),
                        });
                    }
                });
            } catch (error) {
                // The connection is already open with a 200 status, so there
                // is no status code left to change. The only honest way to
                // report a mid-stream failure is an error frame.
                log.error({ err: error }, "agent run failed");
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({ type: "error", message: "Agent run failed" }),
                });
                return;
            }

            // Persist after the stream, not during: writing a row per token
            // would make Postgres the bottleneck in a token-latency budget.
            await deps.storage.createRun({
                kind: "chat",
                status: "succeeded",
                input: { message: body.message },
                output: { text },
            });
        });
    });

    /**
     * POST /v1/sweeps -- enqueue and return immediately.
     *
     * 202 Accepted plus a location to poll. The request handler must not run
     * the sweep: an HTTP timeout, a deploy, or a scale-down would lose the
     * work with no record that it ever started.
     */
    app.post("/v1/sweeps", zValidator("json", SweepRequestSchema), async (c) => {
        const body = c.req.valid("json");
        const run = await deps.storage.createRun({
            kind: "sweep",
            status: "queued",
            input: body,
        });

        if (!run) {
            return c.json({ error: "Storage is not configured; set DATABASE_URL." }, 503);
        }
        return c.json({ id: run.id, status: run.status }, 202);
    });

    app.get("/v1/runs/:id", async (c) => {
        const run = await deps.storage.getRun(c.req.param("id"));
        if (!run) return c.json({ error: "Run not found." }, 404);
        return c.json(run);
    });

    /**
     * The last-resort error handler.
     *
     * Hono catches anything a handler throws. Note what leaves the process:
     * the message goes to the log, and the client gets a constant string.
     * Echoing `error.message` into a response body is how stack traces and
     * connection strings end up in someone else's browser.
     */
    app.onError((error, c) => {
        deps.logger.error({ err: error, path: c.req.path }, "unhandled request error");
        return c.json({ error: "Internal error" }, 500);
    });

    app.notFound((c) => c.json({ error: "Not found" }, 404));

    return app;
}

export type App = ReturnType<typeof createApp>;

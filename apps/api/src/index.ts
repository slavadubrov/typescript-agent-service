/**
 * API entry point.
 *
 * Order matters here in a way it does not in Python. `startTracing` patches
 * the `http` and `pg` modules, so it has to run before anything that uses
 * them. Import order in ES modules is not the order of the statements in this
 * file -- every import is hoisted and evaluated first -- which is why the SDK
 * is started inside a function called at the top of `main()` and the modules
 * it instruments are only *used* afterwards.
 */

import { createClient, createStorage, runAgent } from "@agent/core";
import { createLogger, startTracing, stopTracing } from "@agent/observability";
import { loadEnv } from "@agent/schemas";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

function main(): void {
    // Fails loudly, once, before a single request arrives.
    const env = loadEnv();

    startTracing({
        serviceName: "agent-api",
        endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });

    const logger = createLogger({
        level: env.LOG_LEVEL,
        pretty: env.NODE_ENV === "development",
    });
    const storage = createStorage(env.DATABASE_URL);
    const client = createClient(env.OPENAI_BASE_URL, env.OPENAI_API_KEY);

    const app = createApp({
        env,
        logger,
        storage,
        runAgent: ({ message, maxSteps }) => runAgent({ message, maxSteps, model: env.AGENT_MODEL, client }),
    });

    const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
        logger.info({ port: info.port, model: env.AGENT_MODEL }, "api listening");
    });

    // Cloud Run, Kubernetes, and ECS all send SIGTERM and then wait. A process
    // that ignores it gets SIGKILL mid-request. Draining here is what turns a
    // deploy from "some 502s" into "no 502s".
    const shutdown = async (signal: string) => {
        logger.info({ signal }, "draining");
        server.close();
        await storage.close();
        await stopTracing();
        process.exit(0);
    };

    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
}

main();

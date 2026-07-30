/**
 * The worker: a polling loop over the `runs` table.
 *
 * Celery's shape is `@app.task` plus a broker plus `celery worker`. This is
 * the same three parts collapsed into one file, because Postgres is already
 * there and `FOR UPDATE SKIP LOCKED` is already a queue. See
 * packages/agent-core/src/db/storage.ts for the claim query.
 *
 * Run as many copies as you like. Correctness comes from the row lock, not
 * from coordination between processes.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { Storage } from "@agent/core";
import { createStorage, runSweep } from "@agent/core";
import type { Logger } from "@agent/observability";
import { createLogger, startTracing, stopTracing, withSpan } from "@agent/observability";
import { loadEnv, SweepRequestSchema } from "@agent/schemas";

const IDLE_DELAY_MS = 1_000;

/**
 * Process at most one job, and report whether it found one.
 *
 * Exported and dependency-injected so the test can drive it with a fake
 * storage instead of a database and a real clock.
 */
export async function processOne(storage: Storage, logger: Logger): Promise<boolean> {
    const run = await storage.claimRun("sweep");
    if (!run) return false;

    const log = logger.child({ runId: run.id });

    return withSpan("worker.sweep", { "run.id": run.id }, async () => {
        try {
            // The row came out of jsonb as `unknown`. It was validated on the
            // way in, but it has been through a database since then, and
            // re-parsing costs microseconds. Trusting stored JSON is how a
            // schema change from six months ago crashes a worker at 02:00.
            const input = SweepRequestSchema.parse(run.input);
            const result = await runSweep(input);
            await storage.finishRun(run.id, result);
            log.info({ rows: result.rows.length }, "sweep finished");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await storage.failRun(run.id, message);
            log.error({ err: error }, "sweep failed");
        }
        return true;
    });
}

async function main(): Promise<void> {
    const env = loadEnv();
    startTracing({
        serviceName: "agent-worker",
        endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });

    const logger = createLogger({
        level: env.LOG_LEVEL,
        pretty: env.NODE_ENV === "development",
    });
    const storage = createStorage(env.DATABASE_URL);

    if (!env.DATABASE_URL) {
        logger.warn("DATABASE_URL is unset; the worker has nothing to poll");
    }

    // `AbortController` is the Web-standard cancellation primitive and the
    // closest thing to `asyncio.CancelledError`. Everything that takes an
    // `AbortSignal` -- fetch, timers, the OpenAI SDK -- participates in it.
    const controller = new AbortController();
    const stop = async () => {
        controller.abort();
        await storage.close();
        await stopTracing();
    };
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());

    logger.info("worker started");

    while (!controller.signal.aborted) {
        let worked = false;
        try {
            worked = await processOne(storage, logger);
        } catch (error) {
            // A failure to *claim* is infrastructure, not job failure. Back off
            // rather than spinning on a database that is restarting.
            logger.error({ err: error }, "claim failed");
            await sleep(5_000);
        }

        // Only sleep when idle. Backlogs drain at full speed; an empty queue
        // costs one query per second instead of a hot loop.
        if (!worked) {
            try {
                await sleep(IDLE_DELAY_MS, undefined, { signal: controller.signal });
            } catch {
                break; // aborted during the sleep
            }
        }
    }

    logger.info("worker stopped");
}

// `import.meta.url` is the ESM replacement for `__file__`. This condition is
// the `if __name__ == "__main__":` of Node: run only when executed directly,
// stay quiet when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}

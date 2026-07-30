/**
 * The long-running job the worker executes.
 *
 * A capacity sweep evaluates KV-cache footprint across a range of batch sizes.
 * It is CPU-bound, deterministic, and slow enough (deliberately) to show why
 * it does not belong inside an HTTP request.
 *
 * The `await setTimeout(0)` in the loop is the detail worth internalising.
 * Node runs your JavaScript on one thread. A tight synchronous loop does not
 * "share" that thread the way a Python thread shares the GIL under I/O -- it
 * holds it completely, and every other request, health check, and timer waits.
 * Yielding to the event loop is how you stay responsive.
 *
 * For work that is genuinely heavy, yielding is not enough and you want
 * `worker_threads` (Node's `multiprocessing.Pool`) or a separate service.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { SweepRequest, SweepResult } from "@agent/schemas";
import { kvCacheGiB, lookupModel } from "./tools.ts";

export async function runSweep(request: SweepRequest): Promise<SweepResult> {
    const spec = lookupModel(request.model);
    const rows: SweepResult["rows"] = [];

    for (const batchSize of request.batchSizes) {
        rows.push({
            batchSize,
            kvCacheGiB: Number(kvCacheGiB(spec, request.seqLen, batchSize).toFixed(3)),
        });

        // `node:timers/promises` gives you a promise-returning setTimeout, so
        // this line is Python's `await asyncio.sleep(0)`. Without it, a long
        // sweep blocks the worker's health endpoint.
        await sleep(0);
    }

    return { model: spec.name, seqLen: request.seqLen, rows };
}

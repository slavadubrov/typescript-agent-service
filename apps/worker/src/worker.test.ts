/**
 * Worker tests against a fake storage.
 *
 * `processOne` exists as a separate exported function precisely so the polling
 * loop -- which never terminates and sleeps for real seconds -- does not have
 * to be tested. Extract the unit of work, test that, and leave the `while` to
 * an integration check.
 */

import type { Run, Storage } from "@agent/core";
import type { Logger } from "@agent/observability";
import { describe, expect, it, vi } from "vitest";
import { processOne } from "./index.ts";

const silentLogger = {
    child: () => silentLogger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
} as unknown as Logger;

function queuedRun(input: unknown): Run {
    return {
        id: "run-1",
        kind: "sweep",
        status: "running",
        input,
        output: null,
        error: null,
        lockedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

function storageWith(run: Run | undefined, overrides: Partial<Storage> = {}): Storage {
    let served = false;
    return {
        // Serve the run once, then behave like an empty queue.
        claimRun: vi.fn(async () => {
            if (served) return undefined;
            served = true;
            return run;
        }),
        createRun: vi.fn(async () => undefined),
        finishRun: vi.fn(async () => {}),
        failRun: vi.fn(async () => {}),
        getRun: vi.fn(async () => undefined),
        close: vi.fn(async () => {}),
        ...overrides,
    };
}

describe("processOne", () => {
    it("reports false when the queue is empty", async () => {
        const storage = storageWith(undefined);
        await expect(processOne(storage, silentLogger)).resolves.toBe(false);
    });

    it("computes the sweep and stores the result", async () => {
        const finishRun = vi.fn(async () => {});
        const storage = storageWith(
            queuedRun({ model: "llama-3.1-8b", seqLen: 4096, batchSizes: [1, 2, 4] }),
            { finishRun },
        );

        await expect(processOne(storage, silentLogger)).resolves.toBe(true);

        expect(finishRun).toHaveBeenCalledWith(
            "run-1",
            expect.objectContaining({
                model: "llama-3.1-8b",
                rows: [
                    { batchSize: 1, kvCacheGiB: 0.5 },
                    { batchSize: 2, kvCacheGiB: 1 },
                    { batchSize: 4, kvCacheGiB: 2 },
                ],
            }),
        );
    });

    it("fails the run rather than the process when stored input no longer validates", async () => {
        // A row written by an older deploy, with a field the schema has since
        // tightened. Without the re-parse in processOne, this crashes the
        // worker and the job is retried forever.
        const failRun = vi.fn(async () => {});
        const storage = storageWith(queuedRun({ model: "llama-3.1-8b", seqLen: "lots" }), { failRun });

        await expect(processOne(storage, silentLogger)).resolves.toBe(true);
        expect(failRun).toHaveBeenCalledWith("run-1", expect.stringContaining("seqLen"));
    });

    it("fails the run when the model is not in the registry", async () => {
        const failRun = vi.fn(async () => {});
        const storage = storageWith(queuedRun({ model: "gpt-9", seqLen: 1024, batchSizes: [1] }), {
            failRun,
        });

        await expect(processOne(storage, silentLogger)).resolves.toBe(true);
        expect(failRun).toHaveBeenCalledWith("run-1", expect.stringContaining("Unknown model"));
    });
});

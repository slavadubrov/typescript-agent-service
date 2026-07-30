/**
 * Integration tests against a real Postgres.
 *
 * `describe.skipIf` is Vitest's `@pytest.mark.skipif`. Without DATABASE_URL
 * these tests disappear from the run instead of failing, so `pnpm test` works
 * on a fresh clone with nothing installed:
 *
 *     pnpm db:up
 *     DATABASE_URL=postgres://agent:agent@localhost:5432/agent pnpm db:push
 *     DATABASE_URL=postgres://agent:agent@localhost:5432/agent pnpm test
 *
 * The claim test is the one worth reading. It runs two claims concurrently and
 * asserts they get different rows -- the property FOR UPDATE SKIP LOCKED
 * exists to provide, and the one a naive `SELECT ... LIMIT 1; UPDATE ...`
 * silently fails to provide under load.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createStorage } from "./storage.ts";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("createStorage (integration)", () => {
    const storage = createStorage(databaseUrl);

    // Runs are created fresh per test rather than truncating the table, so
    // these tests do not fight each other or anything else using the database.
    const sweepInput = {
        model: "llama-3.1-8b",
        seqLen: 4096,
        batchSizes: [1, 2],
    };

    beforeEach(async () => {
        // Drain anything a previous run left queued.
        while (await storage.claimRun("sweep")) {
            // intentionally empty
        }
    });

    afterAll(async () => {
        await storage.close();
    });

    it("round-trips a run through create, claim, and finish", async () => {
        const created = await storage.createRun({
            kind: "sweep",
            input: sweepInput,
        });
        expect(created?.status).toBe("queued");

        const claimed = await storage.claimRun("sweep");
        expect(claimed?.id).toBe(created?.id);
        expect(claimed?.status).toBe("running");
        expect(claimed?.lockedAt).toBeInstanceOf(Date);

        await storage.finishRun(created?.id ?? "", { rows: [] });

        const finished = await storage.getRun(created?.id ?? "");
        expect(finished?.status).toBe("succeeded");
        expect(finished?.lockedAt).toBeNull();
    });

    it("never hands the same row to two concurrent claims", async () => {
        const a = await storage.createRun({ kind: "sweep", input: sweepInput });
        const b = await storage.createRun({ kind: "sweep", input: sweepInput });

        // `Promise.all` is `asyncio.gather`. Both claims are in flight at the
        // same time against the same table.
        const [first, second] = await Promise.all([storage.claimRun("sweep"), storage.claimRun("sweep")]);

        const ids = [first?.id, second?.id].filter(Boolean).sort();
        expect(ids).toHaveLength(2);
        expect(ids).toEqual([a?.id, b?.id].sort());
    });

    it("returns undefined when the queue is empty", async () => {
        await expect(storage.claimRun("sweep")).resolves.toBeUndefined();
    });

    it("records a failure without losing the input", async () => {
        const created = await storage.createRun({
            kind: "sweep",
            input: sweepInput,
        });
        await storage.claimRun("sweep");
        await storage.failRun(created?.id ?? "", "Unknown model 'gpt-9'.");

        const failed = await storage.getRun(created?.id ?? "");
        expect(failed?.status).toBe("failed");
        expect(failed?.error).toContain("gpt-9");
        expect(failed?.input).toEqual(sweepInput);
    });
});

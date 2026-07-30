/**
 * Run storage and the job queue, both on Postgres.
 *
 * There is no Redis and no BullMQ here. `SELECT ... FOR UPDATE SKIP LOCKED` is
 * a queue, it is transactional with the rest of your writes, and it costs one
 * table. Reach for BullMQ when you need delayed jobs, repeatable schedules,
 * priorities, rate limits, or a dashboard -- the same list of reasons you
 * would reach for Celery over a database table in Python.
 *
 * Every function tolerates a missing database. `createStorage(undefined)`
 * returns a no-op implementation so the demo runs with nothing installed.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { type NewRun, type Run, runs } from "./schema.ts";

export interface Storage {
    createRun(run: NewRun): Promise<Run | undefined>;
    finishRun(id: string, output: unknown): Promise<void>;
    failRun(id: string, error: string): Promise<void>;
    getRun(id: string): Promise<Run | undefined>;
    /** Atomically claim one queued run of the given kind. */
    claimRun(kind: Run["kind"], staleAfterMs?: number): Promise<Run | undefined>;
    close(): Promise<void>;
}

/** Used when DATABASE_URL is unset. Every call succeeds and stores nothing. */
const NO_OP: Storage = {
    createRun: async () => undefined,
    finishRun: async () => {},
    failRun: async () => {},
    getRun: async () => undefined,
    claimRun: async () => undefined,
    close: async () => {},
};

export function createStorage(databaseUrl: string | undefined): Storage {
    if (!databaseUrl) return NO_OP;

    // A connection pool, not a connection. `pg` opens lazily, so constructing
    // the pool does not touch the network -- which is why this function is
    // synchronous and safe to call at import time.
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const db: NodePgDatabase = drizzle(pool);

    return {
        async createRun(run) {
            const [row] = await db.insert(runs).values(run).returning();
            return row;
        },

        async finishRun(id, output) {
            await db
                .update(runs)
                .set({
                    status: "succeeded",
                    output,
                    lockedAt: null,
                    updatedAt: new Date(),
                })
                .where(eq(runs.id, id));
        },

        async failRun(id, error) {
            await db
                .update(runs)
                .set({ status: "failed", error, lockedAt: null, updatedAt: new Date() })
                .where(eq(runs.id, id));
        },

        async getRun(id) {
            const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
            return row;
        },

        /**
         * Claim one job.
         *
         * `FOR UPDATE SKIP LOCKED` is the whole trick: the row is locked for
         * the duration of the transaction, and any concurrent worker running
         * the same query steps over it instead of blocking. Two workers can
         * poll at the same millisecond and will never take the same job.
         *
         * The `lockedAt` clause recovers jobs whose worker died mid-run --
         * without it, a crashed process leaves a row stuck in "running"
         * forever.
         */
        async claimRun(kind, staleAfterMs = 5 * 60_000) {
            const staleBefore = new Date(Date.now() - staleAfterMs);

            return db.transaction(async (tx) => {
                const [candidate] = await tx
                    .select({ id: runs.id })
                    .from(runs)
                    .where(
                        and(
                            eq(runs.kind, kind),
                            or(
                                eq(runs.status, "queued"),
                                and(eq(runs.status, "running"), sql`${runs.lockedAt} < ${staleBefore}`),
                                and(eq(runs.status, "running"), isNull(runs.lockedAt)),
                            ),
                        ),
                    )
                    .orderBy(runs.createdAt)
                    .limit(1)
                    // Drizzle has no builder method for this, so it goes in raw.
                    // Escaping to SQL for one clause is normal and expected;
                    // that is the point of a SQL-first ORM.
                    .for("update", { skipLocked: true });

                if (!candidate) return undefined;

                const [claimed] = await tx
                    .update(runs)
                    .set({
                        status: "running",
                        lockedAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .where(eq(runs.id, candidate.id))
                    .returning();

                return claimed;
            });
        },

        async close() {
            await pool.end();
        },
    };
}

export type { NewRun, Run };

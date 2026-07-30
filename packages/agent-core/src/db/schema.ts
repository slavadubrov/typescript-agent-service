/**
 * The database schema, declared in TypeScript.
 *
 * Drizzle is the SQLAlchemy of this stack, with one important difference:
 * there is no separate migration DSL and no code generation step. The table
 * below IS the schema, and `drizzle-kit` diffs it against the live database to
 * produce SQL. Prisma takes the other route (a `.prisma` file plus a generated
 * client); pick Drizzle if you are fluent in SQL and want to stay close to it.
 *
 * One table covers both jobs the service needs. A chat run and a sweep run
 * differ only in `kind`, so a second table would buy nothing but a join.
 */

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const runs = pgTable(
    "runs",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        /** "chat" runs stream through the API; "sweep" runs are claimed by the worker. */
        kind: text("kind").$type<"chat" | "sweep">().notNull(),

        // `$type<...>()` narrows a column's TypeScript type without changing
        // the SQL. The database still stores text; the compiler now rejects
        // `status: "pending "` with a trailing space.
        status: text("status")
            .$type<"queued" | "running" | "succeeded" | "failed">()
            .notNull()
            .default("queued"),

        // jsonb, not json. jsonb is parsed and indexable; json is a string
        // Postgres re-parses on every read.
        input: jsonb("input").notNull(),
        output: jsonb("output"),
        error: text("error"),

        /** Set when a worker claims the row, cleared when it finishes. */
        lockedAt: timestamp("locked_at", { withTimezone: true }),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    // The index the worker's claim query needs. Without it, every poll is a
    // sequential scan, which is fine at ten rows and not at ten million.
    (table) => [index("runs_claim_idx").on(table.kind, table.status, table.createdAt)],
);

/**
 * `$inferSelect` and `$inferInsert` read row types out of the table
 * definition. They differ: columns with defaults are optional on insert and
 * always present on select. Hand-writing both types is how they drift.
 */
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

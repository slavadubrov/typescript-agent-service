/**
 * drizzle-kit is Alembic. `drizzle-kit generate` writes a migration by diffing
 * the TypeScript schema against the recorded state; `drizzle-kit migrate`
 * applies it; `drizzle-kit push` skips the migration file and syncs the
 * database directly.
 *
 * Use `push` in development. Use `generate` + `migrate` anywhere you need a
 * reviewable, replayable history -- which is anywhere with production data.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: "./packages/agent-core/src/db/schema.ts",
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "postgres://agent:agent@localhost:5432/agent",
    },
});

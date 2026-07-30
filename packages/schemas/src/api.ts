/**
 * HTTP request and response shapes.
 *
 * These schemas are used twice: Hono validates incoming JSON against them at
 * the edge, and TypeScript derives the handler's parameter types from the same
 * declaration. That is the FastAPI + pydantic arrangement, assembled by hand
 * out of two libraries instead of arriving in one.
 */

import { z } from "zod";

/** POST /v1/chat -- streams an agent run back as Server-Sent Events. */
export const ChatRequestSchema = z.object({
    // `.max()` is not decoration. It is the boundary check that keeps a
    // 40 MB prompt from reaching the tokenizer.
    message: z.string().min(1).max(8_000),

    // `.optional()` makes the property `string | undefined`. TypeScript
    // distinguishes "absent" (undefined) from "explicitly empty" (null), and
    // Zod models both -- `.nullish()` accepts either.
    conversationId: z.uuid().optional(),

    /** Hard ceiling on tool-calling rounds. The loop stops, it does not throw. */
    maxSteps: z.coerce.number().int().min(1).max(12).default(6),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** POST /v1/sweeps -- enqueues a long job for the worker to pick up. */
export const SweepRequestSchema = z.object({
    model: z.string().min(1),
    seqLen: z.coerce.number().int().min(1).max(1_000_000),
    /** Batch sizes to evaluate. Bounded so one request cannot pin a worker. */
    batchSizes: z.array(z.coerce.number().int().min(1).max(4_096)).min(1).max(32),
});

export type SweepRequest = z.infer<typeof SweepRequestSchema>;

/** What the worker writes back into `runs.output` for a sweep. */
export const SweepResultSchema = z.object({
    model: z.string(),
    seqLen: z.number(),
    rows: z.array(
        z.object({
            batchSize: z.number(),
            kvCacheGiB: z.number(),
        }),
    ),
});

export type SweepResult = z.infer<typeof SweepResultSchema>;

/** Shared error body. One shape for every failure the API returns. */
export const ErrorResponseSchema = z.object({
    error: z.string(),
    detail: z.unknown().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

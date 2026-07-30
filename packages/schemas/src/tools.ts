/**
 * Tool input schemas.
 *
 * These live in `@agent/schemas` rather than next to the tool implementations
 * because three separate consumers need the same definition:
 *
 *   1. the explicit loop, which converts them to JSON Schema for the model;
 *   2. the Vercel AI SDK loop, which accepts a Zod schema directly;
 *   3. the MCP server, which publishes them to any MCP client.
 *
 * Writing the shape once is the entire argument for a `schemas` package.
 */

import { z } from "zod";

/** Look up the architecture constants for a served model. */
export const LookupModelInput = z.object({
    // `.describe()` text is carried into the generated JSON Schema and reaches
    // the model. Treat it as prompt surface, not as a code comment.
    name: z.string().min(1).describe("Model identifier, for example 'llama-3.1-8b'."),
});

export type LookupModelInput = z.infer<typeof LookupModelInput>;

/** Estimate KV-cache footprint for a serving configuration. */
export const EstimateKvCacheInput = z.object({
    model: z.string().min(1).describe("Model identifier to look up first."),
    seqLen: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .describe("Sequence length in tokens, including generated tokens."),
    batchSize: z.number().int().min(1).max(4_096).describe("Number of concurrent sequences."),
});

export type EstimateKvCacheInput = z.infer<typeof EstimateKvCacheInput>;

/** What `lookup_model` returns. Also the row shape of the static registry. */
export const ModelSpec = z.object({
    name: z.string(),
    numLayers: z.number().int(),
    numKvHeads: z.number().int(),
    headDim: z.number().int(),
    /** Bytes per cached element: 2 for fp16/bf16, 1 for fp8. */
    kvDtypeBytes: z.union([z.literal(1), z.literal(2)]),
});

export type ModelSpec = z.infer<typeof ModelSpec>;

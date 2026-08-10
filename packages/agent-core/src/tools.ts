/**
 * The tool registry.
 *
 * A tool is three things bolted together: a name the model sees, a Zod schema
 * that describes and validates its arguments, and an async function that does
 * the work. Every agent framework in every language reduces to this triple.
 * Writing it out once is how you stop treating frameworks as magic.
 *
 * The domain here is deliberately boring and deterministic: KV-cache sizing
 * for a served model. It needs no network, produces the same answer every
 * time, and is therefore testable without an API key.
 */

import { EstimateKvCacheInput, LookupModelInput, type ModelSpec } from "@agent/schemas";
import { z } from "zod";

/**
 * `AgentTool` is generic over its input type.
 *
 * `<TInput>` is the same idea as Python's `TypeVar`. The constraint that ties
 * `schema` to `execute` is what makes the registry safe: you cannot register a
 * tool whose handler expects a shape the schema never produces.
 *
 * `z.ZodType<TInput>` says "any Zod schema that parses to TInput".
 */
export interface AgentTool<TInput = unknown> {
    name: string;
    description: string;
    schema: z.ZodType<TInput>;
    execute: (input: TInput) => Promise<unknown>;
}

/**
 * The type-erased view the loop iterates over.
 *
 * You cannot put `AgentTool<A>` and `AgentTool<B>` in one array and keep both
 * types -- TypeScript has no existential types, so the array's element type
 * collapses to a union and `execute` becomes uncallable. Python papers over
 * this because nothing is checked at runtime; here you have to erase
 * deliberately, in one place, with the cast visible.
 *
 * `parse` and `execute` are closures that captured the original `TInput`, so
 * the erasure is safe: `execute` only ever receives what `parse` produced.
 */
export interface RuntimeTool {
    name: string;
    description: string;
    /** JSON Schema, ready to hand to the model. */
    parameters: Record<string, unknown>;
    parse(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string };
    execute(input: unknown): Promise<unknown>;
}

export function defineTool<TInput>(tool: AgentTool<TInput>): RuntimeTool {
    return {
        name: tool.name,
        description: tool.description,
        // `z.toJSONSchema` ships inside Zod 4, so there is no
        // `zod-to-json-schema` dependency to keep in step with it.
        // `io: "input"` matters when a schema has defaults or transforms: the
        // input shape and the parsed output shape differ, and the model needs
        // the input one.
        // OpenAI strict tools require a closed object schema. Zod deliberately
        // omits this for input schemas because plain z.object() strips extras.
        parameters: {
            ...z.toJSONSchema(tool.schema, { io: "input" }),
            additionalProperties: false,
        } as Record<string, unknown>,
        parse(raw) {
            const result = tool.schema.safeParse(raw);
            return result.success
                ? { ok: true, value: result.data }
                : { ok: false, error: z.prettifyError(result.error) };
        },
        // The one cast in the file. It is sound because the only caller is the
        // loop, which passes the value `parse` just returned.
        execute: (input) => tool.execute(input as TInput),
    };
}

/**
 * A small static model registry.
 *
 * `satisfies` is the operator worth stealing from TypeScript. It checks the
 * literal against a type WITHOUT widening it, so `MODELS` keeps its exact keys
 * (autocomplete works, typos are errors) while still being validated against
 * `Record<string, ModelSpec>`. A plain `: Record<string, ModelSpec>`
 * annotation would throw the key names away.
 */
export const MODELS = {
    "llama-3.1-8b": {
        name: "llama-3.1-8b",
        numLayers: 32,
        numKvHeads: 8,
        headDim: 128,
        kvDtypeBytes: 2,
    },
    "llama-3.1-70b": {
        name: "llama-3.1-70b",
        numLayers: 80,
        numKvHeads: 8,
        headDim: 128,
        kvDtypeBytes: 2,
    },
    "qwen3-32b": {
        name: "qwen3-32b",
        numLayers: 64,
        numKvHeads: 8,
        headDim: 128,
        kvDtypeBytes: 2,
    },
    "mistral-7b": {
        name: "mistral-7b",
        numLayers: 32,
        numKvHeads: 8,
        headDim: 128,
        kvDtypeBytes: 2,
    },
} satisfies Record<string, ModelSpec>;

export type KnownModel = keyof typeof MODELS;

/** Thrown by a tool when the input is valid but the request cannot be served. */
export class ToolError extends Error {
    constructor(message: string) {
        super(message);
        // Subclassing built-ins requires this line to make `instanceof` and
        // `error.name` behave. It is boilerplate, and it is not optional.
        this.name = "ToolError";
    }
}

/**
 * Pure KV-cache arithmetic, exported so tests can assert it directly.
 *
 *   bytes = 2 (K and V) x layers x kv_heads x head_dim x dtype_bytes
 *                       x seq_len x batch_size
 *
 * Note `1024 ** 3` and not `1e9`: GiB, not GB. Every capacity argument that
 * ends in "the numbers do not match" starts here.
 */
export function kvCacheGiB(spec: ModelSpec, seqLen: number, batchSize: number): number {
    const bytesPerToken = 2 * spec.numLayers * spec.numKvHeads * spec.headDim * spec.kvDtypeBytes;
    const totalBytes = bytesPerToken * seqLen * batchSize;
    return totalBytes / 1024 ** 3;
}

export function lookupModel(name: string): ModelSpec {
    // `Object.hasOwn` rather than `MODELS[name] !== undefined`, because
    // JavaScript objects inherit from Object.prototype: a lookup of
    // "constructor" or "toString" on a plain object returns a function, not
    // undefined. This is the prototype-chain equivalent of Python's
    // `dict.__contains__` vs `getattr`.
    if (!Object.hasOwn(MODELS, name)) {
        throw new ToolError(`Unknown model '${name}'. Known: ${Object.keys(MODELS).join(", ")}.`);
    }
    return MODELS[name as KnownModel];
}

/**
 * The registry the loop iterates over.
 *
 * Each entry goes through `defineTool`, which infers `TInput` from the schema
 * and hands back the erased form. Inside each `execute` the destructured
 * argument is fully typed: rename `seqLen` to `seq_len` and this file stops
 * compiling.
 */
export const TOOLS: readonly RuntimeTool[] = [
    defineTool({
        name: "lookup_model",
        description:
            "Look up the architecture constants (layers, KV heads, head dim, KV dtype) for a served model.",
        schema: LookupModelInput,
        execute: async ({ name }) => lookupModel(name),
    }),

    defineTool({
        name: "estimate_kv_cache",
        description: "Estimate KV-cache VRAM in GiB for a model at a given sequence length and batch size.",
        schema: EstimateKvCacheInput,
        execute: async ({ model, seqLen, batchSize }) => {
            const spec = lookupModel(model);
            return {
                model: spec.name,
                seqLen,
                batchSize,
                // `toFixed` returns a string; `Number()` puts it back. There is
                // one numeric type in JavaScript (IEEE-754 double), so this is
                // rounding for display, not a precision guarantee.
                kvCacheGiB: Number(kvCacheGiB(spec, seqLen, batchSize).toFixed(3)),
            };
        },
    }),
];

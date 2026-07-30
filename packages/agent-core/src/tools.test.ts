/**
 * Tool tests. Pure arithmetic and pure validation, so no mocking is needed.
 *
 * Vitest -> pytest translation:
 *   describe / it        ->  class Test... / def test_...
 *   expect(x).toBe(y)    ->  assert x == y            (Object.is)
 *   expect(x).toEqual(y) ->  assert x == y            (deep, structural)
 *   it.each([...])       ->  @pytest.mark.parametrize
 *   expect(fn).toThrow() ->  pytest.raises(...)
 */

import { EstimateKvCacheInput } from "@agent/schemas";
import { describe, expect, it } from "vitest";
import { kvCacheGiB, lookupModel, MODELS, ToolError } from "./tools.ts";

describe("kvCacheGiB", () => {
    it("matches a hand-computed reference", () => {
        // 2 * 32 layers * 8 kv heads * 128 head dim * 2 bytes = 131072 B/token
        // 131072 * 4096 tokens * 1 sequence = 536870912 B = exactly 0.5 GiB
        const spec = MODELS["llama-3.1-8b"];
        expect(kvCacheGiB(spec, 4096, 1)).toBe(0.5);
    });

    it("scales linearly in both sequence length and batch size", () => {
        const spec = MODELS["llama-3.1-8b"];
        const base = kvCacheGiB(spec, 4096, 1);
        expect(kvCacheGiB(spec, 8192, 1)).toBe(base * 2);
        expect(kvCacheGiB(spec, 4096, 8)).toBe(base * 8);
    });

    it.each([
        ["llama-3.1-8b", 32],
        ["llama-3.1-70b", 80],
        ["qwen3-32b", 64],
    ] as const)("%s reports %i layers", (name, layers) => {
        expect(lookupModel(name).numLayers).toBe(layers);
    });
});

describe("lookupModel", () => {
    it("rejects an unknown model with a message the agent can act on", () => {
        // `toThrow` accepts a substring. The assertion is on the message
        // because that message is fed back to the model, not just logged.
        expect(() => lookupModel("gpt-9")).toThrow(ToolError);
        expect(() => lookupModel("gpt-9")).toThrow(/Unknown model 'gpt-9'/);
    });

    it("does not resolve inherited Object properties", () => {
        // Without Object.hasOwn, `MODELS["constructor"]` returns a function
        // and the tool would happily read `.numLayers` off it as undefined.
        expect(() => lookupModel("constructor")).toThrow(ToolError);
        expect(() => lookupModel("toString")).toThrow(ToolError);
    });
});

describe("EstimateKvCacheInput", () => {
    it("accepts a valid call", () => {
        const parsed = EstimateKvCacheInput.parse({
            model: "qwen3-32b",
            seqLen: 8192,
            batchSize: 4,
        });
        expect(parsed.batchSize).toBe(4);
    });

    it("rejects a non-integer batch size", () => {
        const result = EstimateKvCacheInput.safeParse({
            model: "qwen3-32b",
            seqLen: 8192,
            batchSize: 4.5,
        });
        expect(result.success).toBe(false);
    });

    it("rejects a batch size past the ceiling", () => {
        const result = EstimateKvCacheInput.safeParse({
            model: "qwen3-32b",
            seqLen: 8192,
            batchSize: 100_000,
        });
        expect(result.success).toBe(false);
    });
});

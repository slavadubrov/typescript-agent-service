/**
 * The same agent, written with the Vercel AI SDK.
 *
 * This file exists so you can diff it against `loop.ts` and see exactly what a
 * framework buys you. It emits the identical `AgentEvent` stream, so the HTTP
 * layer, the tests, and the storage layer cannot tell which one produced it.
 *
 * What disappears compared with the hand-written loop:
 *
 *   - accumulating streamed tool-call fragments by index;
 *   - JSON.parse of the arguments, and the error path when that fails;
 *   - Zod validation of the parsed arguments;
 *   - appending assistant and tool messages in the provider's exact format;
 *   - the `for` loop and the step counter.
 *
 * What you give up: the ability to see any of it. When a model emits arguments
 * that fail validation, `loop.ts` lets you decide what the model is told.
 * Here that behaviour lives behind `repairToolCall` and you configure it
 * rather than write it.
 *
 * Switching providers is the other half of the trade. `createOpenAICompatible`
 * points at vLLM the same way the raw client does, but swapping to Anthropic
 * or Gemini here is a one-line change, and in `loop.ts` it is a rewrite.
 */

import type { AgentEvent } from "@agent/schemas";
import { EstimateKvCacheInput, LookupModelInput } from "@agent/schemas";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ToolSet } from "ai";
import { stepCountIs, streamText, tool } from "ai";
import { kvCacheGiB, lookupModel } from "./tools.ts";

export interface AiSdkRunOptions {
    message: string;
    model: string;
    baseURL: string;
    apiKey: string;
    maxSteps?: number;
    system?: string;
}

/**
 * The AI SDK's tool format. `inputSchema` takes the Zod schema directly -- no
 * JSON Schema conversion step, because the SDK does it internally.
 *
 * A `ToolSet` is a plain object keyed by tool name, so the key is the name.
 * That is tidier than the array-with-a-name-field in `tools.ts`, and it is
 * also why the two files cannot share a registry.
 */
const aiSdkTools = {
    lookup_model: tool({
        description: "Look up the architecture constants for a served model.",
        inputSchema: LookupModelInput,
        execute: async ({ name }) => lookupModel(name),
    }),
    estimate_kv_cache: tool({
        description: "Estimate KV-cache VRAM in GiB for a serving configuration.",
        inputSchema: EstimateKvCacheInput,
        execute: async ({ model, seqLen, batchSize }) => {
            const spec = lookupModel(model);
            return {
                model: spec.name,
                seqLen,
                batchSize,
                kvCacheGiB: Number(kvCacheGiB(spec, seqLen, batchSize).toFixed(3)),
            };
        },
    }),
} satisfies ToolSet;

export async function* runAgentWithAiSdk(options: AiSdkRunOptions): AsyncGenerator<AgentEvent> {
    const provider = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: options.baseURL,
        apiKey: options.apiKey,
    });

    const result = streamText({
        model: provider.chatModel(options.model),
        system: options.system ?? "You size LLM serving deployments. Use the tools for exact numbers.",
        prompt: options.message,
        tools: aiSdkTools,
        // `stopWhen` replaces the `for (let step = 0; ...)` in loop.ts. It
        // takes a condition, so "stop after N steps" is one of several
        // policies rather than the only one the loop structure allows.
        stopWhen: stepCountIs(options.maxSteps ?? 6),
    });

    let text = "";
    let steps = 0;

    // `fullStream` yields every part, not just text. `result.textStream` gives
    // you only the deltas, which is what you want for a plain chat UI.
    for await (const part of result.fullStream) {
        switch (part.type) {
            case "text-delta":
                text += part.text;
                yield { type: "text", delta: part.text };
                break;

            case "tool-call":
                steps += 1;
                yield {
                    type: "tool_call",
                    callId: part.toolCallId,
                    toolName: part.toolName,
                    args: part.input,
                };
                break;

            case "tool-result":
                yield {
                    type: "tool_result",
                    callId: part.toolCallId,
                    toolName: part.toolName,
                    ok: true,
                    result: part.output,
                    durationMs: 0,
                };
                break;

            case "tool-error":
                // The SDK catches a throwing tool and turns it into a part.
                // In loop.ts the equivalent branch is code you wrote, which is
                // the whole difference in one line.
                yield {
                    type: "tool_result",
                    callId: part.toolCallId,
                    toolName: part.toolName,
                    ok: false,
                    result: { error: String(part.error) },
                    durationMs: 0,
                };
                break;

            case "error":
                yield { type: "error", message: String(part.error) };
                return;

            case "finish":
                yield {
                    type: "done",
                    stopReason: part.finishReason === "tool-calls" ? "max_steps" : "stop",
                    steps,
                    text,
                };
                return;

            default:
                // Twenty-odd part types exist and more arrive with each minor
                // release. Ignoring the rest is correct; enumerating them all
                // would break on the next upgrade.
                break;
        }
    }
}

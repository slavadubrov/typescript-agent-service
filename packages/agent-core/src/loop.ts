/**
 * The agent loop, written out by hand.
 *
 * Every agent framework is a wrapper around the twenty lines in `runAgent`:
 *
 *     while (steps < maxSteps):
 *         reply = model(messages, tools)
 *         if reply has no tool calls: return reply
 *         for each tool call: validate args, run tool, append result
 *
 * This file uses the OpenAI SDK's /chat/completions API directly. That choice
 * is deliberate: /chat/completions is the interface vLLM, SGLang, Ollama, and
 * every hosted provider implements, so the same code points at a model you
 * serve yourself by changing one environment variable. OpenAI's newer
 * Responses API is a better API and only OpenAI speaks it.
 *
 * The loop is an `async function*` -- an async generator. In Python you would
 * write `async def run_agent(...) -> AsyncIterator[AgentEvent]` with `yield`.
 * The shape is identical, and it is the right shape here because it lets the
 * HTTP layer stream events, the tests collect them into an array, and the
 * worker persist them, without the loop knowing which one is calling.
 */

import { withSpan } from "@agent/observability";
import type { AgentEvent } from "@agent/schemas";
import OpenAI from "openai";
import type {
    ChatCompletionFunctionTool,
    ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { type RuntimeTool, TOOLS, ToolError } from "./tools.ts";

export interface RunAgentOptions {
    message: string;
    model: string;
    maxSteps?: number;
    tools?: readonly RuntimeTool[];
    client: OpenAI;
    system?: string;
}

const DEFAULT_SYSTEM = [
    "You size LLM serving deployments.",
    "Use the tools to get exact numbers; never guess architecture constants.",
    "Answer in at most three sentences and always state the units.",
].join(" ");

/**
 * Build the OpenAI-format tool declarations. The JSON Schema was already
 * derived from Zod inside `defineTool`, so this is pure reshaping.
 */
export function toolsToOpenAI(tools: readonly RuntimeTool[]): ChatCompletionFunctionTool[] {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            // `strict: true` makes the provider constrain decoding to the
            // schema. It is the same guarantee as vLLM's guided decoding, and
            // it removes an entire failure mode -- but it does not remove the
            // need to validate below. A self-hosted endpoint may ignore it.
            strict: true,
        },
    }));
}

/** Accumulates streamed `tool_calls` fragments into whole calls. */
interface PartialToolCall {
    id: string;
    name: string;
    args: string;
}

export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
    const { message, model, client, maxSteps = 6, tools = TOOLS } = options;

    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const openAITools = toolsToOpenAI(tools);

    // `ChatCompletionMessageParam[]` is the conversation. It grows by one
    // assistant message and N tool messages per step. This array IS the
    // agent's memory for the duration of the run -- nothing else persists it.
    const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: options.system ?? DEFAULT_SYSTEM },
        { role: "user", content: message },
    ];

    let finalText = "";

    for (let step = 0; step < maxSteps; step++) {
        const stream = await client.chat.completions.create({
            model,
            messages,
            tools: openAITools,
            reasoning_effort: "none",
            stream: true,
        });

        let text = "";
        // Keyed by the `index` field, because a streamed response interleaves
        // fragments of several parallel tool calls and only `index` is present
        // on every fragment. `id` and `name` arrive once, `arguments` arrives
        // in pieces. Getting this wrong is the classic first-agent bug.
        const partial = new Map<number, PartialToolCall>();

        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice) continue;

            if (choice.delta.content) {
                text += choice.delta.content;
                yield { type: "text", delta: choice.delta.content };
            }

            for (const fragment of choice.delta.tool_calls ?? []) {
                const slot = partial.get(fragment.index) ?? {
                    id: "",
                    name: "",
                    args: "",
                };
                if (fragment.id) slot.id = fragment.id;
                if (fragment.function?.name) slot.name = fragment.function.name;
                if (fragment.function?.arguments) slot.args += fragment.function.arguments;
                partial.set(fragment.index, slot);
            }
        }

        const calls = [...partial.values()].filter((call) => call.name);

        // No tool calls means the model is answering. That is the only exit
        // that counts as success.
        if (calls.length === 0) {
            finalText = text;
            yield {
                type: "done",
                stopReason: "stop",
                steps: step + 1,
                text: finalText,
            };
            return;
        }

        // Record what the model asked for. The provider rejects a `tool`
        // message whose `tool_call_id` has no matching assistant entry, so
        // this push is not optional bookkeeping.
        messages.push({
            role: "assistant",
            content: text || null,
            tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.args },
            })),
        });

        for (const call of calls) {
            const started = performance.now();
            const result = await executeToolCall(toolByName, call);
            const durationMs = Math.round(performance.now() - started);

            yield {
                type: "tool_call",
                callId: call.id,
                toolName: call.name,
                args: result.parsedArgs,
            };
            yield {
                type: "tool_result",
                callId: call.id,
                toolName: call.name,
                ok: result.ok,
                result: result.value,
                durationMs,
            };

            messages.push({
                role: "tool",
                tool_call_id: call.id,
                // The model only reads strings. An object has to be
                // stringified, and a failure has to be described in words the
                // model can act on -- which is why errors are fed back rather
                // than thrown.
                content: JSON.stringify(result.value),
            });
        }
    }

    // Falling out of the loop is a real outcome, not an exception. The caller
    // decides whether a truncated run is acceptable.
    yield {
        type: "done",
        stopReason: "max_steps",
        steps: maxSteps,
        text: finalText,
    };
}

interface ToolOutcome {
    ok: boolean;
    value: unknown;
    parsedArgs: unknown;
}

/**
 * Validate and run one tool call.
 *
 * Three things can go wrong, and all three become a message the model reads:
 * the tool does not exist, the arguments do not parse, or the tool throws. A
 * thrown exception here would kill the request and lose the run; a returned
 * error gives the model one chance to correct itself.
 */
async function executeToolCall(
    toolByName: ReadonlyMap<string, RuntimeTool>,
    call: PartialToolCall,
): Promise<ToolOutcome> {
    const tool = toolByName.get(call.name);
    if (!tool) {
        return {
            ok: false,
            value: { error: `Unknown tool '${call.name}'.` },
            parsedArgs: undefined,
        };
    }

    // `JSON.parse` throws on malformed input, and models do emit malformed
    // JSON under load. Wrapping it is not defensive programming, it is the
    // documented behaviour of the field.
    let raw: unknown;
    try {
        raw = JSON.parse(call.args || "{}");
    } catch {
        return {
            ok: false,
            value: {
                error: "Arguments were not valid JSON. Re-emit them as a JSON object.",
            },
            parsedArgs: call.args,
        };
    }

    const parsed = tool.parse(raw);
    if (!parsed.ok) {
        return {
            ok: false,
            value: { error: `Invalid arguments: ${parsed.error}` },
            parsedArgs: raw,
        };
    }

    return withSpan("agent.tool", { "tool.name": tool.name }, async () => {
        try {
            const value = await tool.execute(parsed.value);
            return { ok: true, value, parsedArgs: parsed.value };
        } catch (error) {
            // Only a ToolError is a domain failure worth handing back. Anything
            // else is a bug in our code and should reach the error handler, so
            // it shows up in traces instead of being explained to the model.
            if (error instanceof ToolError) {
                return {
                    ok: false,
                    value: { error: error.message },
                    parsedArgs: parsed.value,
                };
            }
            throw error;
        }
    });
}

/** Build the client. Any OpenAI-compatible base URL works. */
export function createClient(baseURL: string, apiKey: string): OpenAI {
    return new OpenAI({ baseURL, apiKey });
}

/**
 * Agent-loop tests with no network and no API key.
 *
 * The loop takes an `OpenAI` client as a parameter instead of constructing
 * one. That single decision is what makes these tests possible: the fake below
 * is an object with a `chat.completions.create` method that returns a
 * scripted async iterable, and the loop cannot tell the difference.
 *
 * This is the same discipline as passing a session into a Python client class
 * instead of building it inside `__init__`, and it pays for itself the first
 * time you need to reproduce a bad tool call.
 */

import type { AgentEvent } from "@agent/schemas";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { runAgent, toolsToOpenAI } from "./loop.ts";
import { TOOLS } from "./tools.ts";

/** One streamed chunk, shaped like the provider's SSE payload. */
type Chunk = {
    choices: Array<{
        delta: {
            content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
            }>;
        };
    }>;
};

/**
 * A client that replays one scripted response per call.
 *
 * `as unknown as OpenAI` is the escape hatch. It is a lie to the compiler, and
 * it is confined to one line in a test file -- which is the only place a cast
 * like this belongs.
 */
function fakeClient(scripts: Chunk[][]): OpenAI {
    let call = 0;
    return {
        chat: {
            completions: {
                create: async () => {
                    const script = scripts[call++] ?? [];
                    return (async function* () {
                        for (const chunk of script) yield chunk;
                    })();
                },
            },
        },
    } as unknown as OpenAI;
}

/** Collect an async generator into an array, the way pytest would. */
async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of gen) events.push(event);
    return events;
}

const text = (content: string): Chunk => ({
    choices: [{ delta: { content } }],
});

describe("runAgent", () => {
    it("streams text and stops when the model asks for no tools", async () => {
        const events = await collect(
            runAgent({
                message: "hello",
                model: "test",
                client: fakeClient([[text("Hi "), text("there.")]]),
            }),
        );

        expect(events.map((e) => e.type)).toEqual(["text", "text", "done"]);
        // `at(-1)` is `events[-1]`. Plain negative indexing does not work on
        // JavaScript arrays -- `events[-1]` reads a property named "-1".
        const done = events.at(-1);
        expect(done).toMatchObject({
            type: "done",
            stopReason: "stop",
            steps: 1,
            text: "Hi there.",
        });
    });

    it("reassembles a tool call that arrives in fragments", async () => {
        // Providers split `arguments` across chunks at arbitrary byte offsets.
        // Only `index` appears on every fragment, which is why the loop keys
        // its accumulator on it. Splitting mid-token here is the point.
        const events = await collect(
            runAgent({
                message: "how big is the kv cache for llama-3.1-8b at 4096 tokens?",
                model: "test",
                client: fakeClient([
                    [
                        {
                            choices: [
                                {
                                    delta: {
                                        tool_calls: [
                                            {
                                                index: 0,
                                                id: "c1",
                                                function: { name: "estimate_kv_cache" },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            choices: [
                                {
                                    delta: {
                                        tool_calls: [
                                            { index: 0, function: { arguments: '{"model":"llama' } },
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            choices: [
                                {
                                    delta: {
                                        tool_calls: [
                                            {
                                                index: 0,
                                                function: { arguments: '-3.1-8b","seqLen":4096,' },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            choices: [
                                {
                                    delta: {
                                        tool_calls: [{ index: 0, function: { arguments: '"batchSize":1}' } }],
                                    },
                                },
                            ],
                        },
                    ],
                    [text("It needs 0.5 GiB.")],
                ]),
            }),
        );

        expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "done"]);

        const result = events[1];
        expect(result).toMatchObject({
            type: "tool_result",
            ok: true,
            result: { model: "llama-3.1-8b", kvCacheGiB: 0.5 },
        });
    });

    it("handles two parallel tool calls in one response", async () => {
        const events = await collect(
            runAgent({
                message: "compare llama-3.1-8b and qwen3-32b",
                model: "test",
                client: fakeClient([
                    [
                        {
                            choices: [
                                {
                                    delta: {
                                        tool_calls: [
                                            {
                                                index: 0,
                                                id: "a",
                                                function: {
                                                    name: "lookup_model",
                                                    arguments: '{"name":"llama-3.1-8b"}',
                                                },
                                            },
                                            {
                                                index: 1,
                                                id: "b",
                                                function: {
                                                    name: "lookup_model",
                                                    arguments: '{"name":"qwen3-32b"}',
                                                },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                    [text("Done.")],
                ]),
            }),
        );

        const results = events.filter((e) => e.type === "tool_result");
        expect(results).toHaveLength(2);
        expect(results.every((r) => r.ok)).toBe(true);
    });

    it("feeds a validation failure back to the model instead of throwing", async () => {
        const events = await collect(
            runAgent({
                message: "estimate something",
                model: "test",
                client: fakeClient([
                    [
                        {
                            choices: [
                                {
                                    delta: {
                                        // batchSize must be an integer. A framework would
                                        // repair or retry this; here you can see exactly
                                        // what the model is told.
                                        tool_calls: [
                                            {
                                                index: 0,
                                                id: "x",
                                                function: {
                                                    name: "estimate_kv_cache",
                                                    arguments:
                                                        '{"model":"qwen3-32b","seqLen":1024,"batchSize":2.5}',
                                                },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                    [text("Let me retry with an integer.")],
                ]),
            }),
        );

        const result = events.find((e) => e.type === "tool_result");
        expect(result?.ok).toBe(false);
        expect(JSON.stringify(result?.result)).toMatch(/Invalid arguments/);
    });

    it("reports malformed JSON arguments as a tool error", async () => {
        const events = await collect(
            runAgent({
                message: "x",
                model: "test",
                client: fakeClient([
                    [
                        {
                            choices: [
                                {
                                    delta: {
                                        tool_calls: [
                                            {
                                                index: 0,
                                                id: "y",
                                                function: {
                                                    name: "lookup_model",
                                                    arguments: "{not json",
                                                },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                    [text("Sorry.")],
                ]),
            }),
        );

        const result = events.find((e) => e.type === "tool_result");
        expect(result?.ok).toBe(false);
        expect(JSON.stringify(result?.result)).toMatch(/not valid JSON/);
    });

    it("stops at maxSteps instead of looping forever", async () => {
        // A model that calls a tool on every turn. Without the ceiling this
        // test would run until the process died.
        const loopingCall: Chunk[] = [
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "z",
                                    function: {
                                        name: "lookup_model",
                                        arguments: '{"name":"mistral-7b"}',
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        ];

        const events = await collect(
            runAgent({
                message: "spin",
                model: "test",
                maxSteps: 3,
                client: fakeClient([loopingCall, loopingCall, loopingCall, loopingCall]),
            }),
        );

        expect(events.at(-1)).toMatchObject({
            type: "done",
            stopReason: "max_steps",
            steps: 3,
        });
    });

    it("surfaces an unknown tool name without crashing", async () => {
        const events = await collect(
            runAgent({
                message: "x",
                model: "test",
                client: fakeClient([
                    [
                        {
                            choices: [
                                {
                                    delta: {
                                        tool_calls: [
                                            {
                                                index: 0,
                                                id: "q",
                                                function: { name: "rm_rf", arguments: "{}" },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                    [text("That tool does not exist.")],
                ]),
            }),
        );

        expect(events.find((e) => e.type === "tool_result")).toMatchObject({
            ok: false,
        });
    });
});

describe("toolsToOpenAI", () => {
    it("emits JSON Schema the provider will accept", () => {
        const [first] = toolsToOpenAI(TOOLS);
        expect(first?.function.name).toBe("lookup_model");
        expect(first?.function.strict).toBe(true);
        // `.describe()` text has to reach the model, or the schema is a
        // validator the model never sees the intent of.
        expect(JSON.stringify(first?.function.parameters)).toMatch(/Model identifier/);
    });
});

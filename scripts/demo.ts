/**
 * `pnpm demo` -- the whole service, offline, in one process.
 *
 * No API key, no database, no Docker. The model is a scripted fake that
 * replays a two-step tool conversation, so the output is identical on every
 * run. Everything else is the production code path: the real loop, the real
 * Hono app, the real SSE framing, the real sweep.
 *
 * Point it at a live model instead by setting OPENAI_API_KEY and running
 * `pnpm dev:api`.
 */

import { createApp } from "../apps/api/src/app.ts";
import type { RunAgentOptions } from "../packages/agent-core/src/index.ts";
import { createStorage, runAgent, runSweep } from "../packages/agent-core/src/index.ts";
import { createLogger } from "../packages/observability/src/index.ts";
import { loadEnv } from "../packages/schemas/src/index.ts";

/**
 * A model that calls one tool, reads the result, then answers.
 *
 * The return type is read out of `runAgent`'s own options rather than
 * imported from the `openai` package. `RunAgentOptions["client"]` is an
 * indexed access type -- the equivalent of reaching into a TypedDict for one
 * field's type -- and it means this script does not need `openai` as a
 * dependency just to name a type.
 */
function scriptedClient(): RunAgentOptions["client"] {
    const scripts = [
        [
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_1",
                                    function: {
                                        name: "estimate_kv_cache",
                                        arguments: '{"model":"llama-3.1-8b","seqLen":32768,"batchSize":16}',
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        ],
        [
            { choices: [{ delta: { content: "Llama-3.1-8B at 32k context " } }] },
            { choices: [{ delta: { content: "and batch 16 needs 64 GiB " } }] },
            { choices: [{ delta: { content: "of KV cache." } }] },
        ],
    ];

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
    } as unknown as RunAgentOptions["client"];
}

const env = loadEnv({ LOG_LEVEL: "error" });
const logger = createLogger({ level: "error" });
const storage = createStorage(undefined); // no-op storage
const client = scriptedClient();

const app = createApp({
    env,
    logger,
    storage,
    runAgent: ({ message, maxSteps }) => runAgent({ message, maxSteps, model: "scripted", client }),
});

console.log("--- POST /v1/chat (SSE) ---");

const response = await app.request("/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        message: "How much KV cache for llama-3.1-8b at 32k, batch 16?",
    }),
});

// `response.body` is a Web ReadableStream. In Node 18+ it is async-iterable,
// so `for await` works directly -- the same shape as iterating an httpx
// streaming response in Python.
const decoder = new TextDecoder();
for await (const chunk of response.body ?? []) {
    process.stdout.write(decoder.decode(chunk as Uint8Array));
}

console.log("\n--- worker: capacity sweep ---");

const sweep = await runSweep({
    model: "llama-3.1-8b",
    seqLen: 32_768,
    batchSizes: [1, 4, 16, 64],
});
for (const row of sweep.rows) {
    console.log(`batch=${String(row.batchSize).padStart(3)}  kv_cache=${row.kvCacheGiB.toFixed(1)} GiB`);
}

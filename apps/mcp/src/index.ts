/**
 * An MCP server exposing one capability over stdio.
 *
 * MCP is how a tool you wrote becomes available to Claude Code, Cursor, or any
 * other MCP client without either side importing the other's code. The server
 * speaks JSON-RPC over stdin/stdout; the client launches it as a subprocess.
 *
 * The tool it publishes is the same `estimate_kv_cache` the agent uses, backed
 * by the same Zod schema from `@agent/schemas`. Writing the schema once and
 * serving it to three consumers is the entire reason that package exists.
 *
 * One rule that costs people an afternoon: **stdout is the protocol channel**.
 * A stray `console.log` corrupts the JSON-RPC stream and the client
 * disconnects with a parse error that names no file. Diagnostics go to stderr.
 */

import { kvCacheGiB, lookupModel, ToolError } from "@agent/core";
import { EstimateKvCacheInput } from "@agent/schemas";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
    name: "kv-cache-planner",
    version: "0.1.0",
});

server.registerTool(
    "estimate_kv_cache",
    {
        title: "Estimate KV cache",
        description:
            "Estimate KV-cache VRAM in GiB for a served model at a given sequence length and batch size.",
        // The SDK wants the raw shape, not the wrapping object schema.
        // `.shape` unwraps a `z.object(...)` back into `{ key: schema }`.
        inputSchema: EstimateKvCacheInput.shape,
    },
    async ({ model, seqLen, batchSize }) => {
        try {
            const spec = lookupModel(model);
            const gib = kvCacheGiB(spec, seqLen, batchSize);

            return {
                // MCP results are content blocks, so a number has to be
                // rendered. Returning JSON alongside prose gives the calling
                // model both a sentence to quote and a value to reuse.
                content: [
                    {
                        type: "text" as const,
                        text: `${spec.name} at seq_len=${seqLen}, batch=${batchSize} needs ${gib.toFixed(2)} GiB of KV cache.`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            model: spec.name,
                            seqLen,
                            batchSize,
                            kvCacheGiB: Number(gib.toFixed(3)),
                        }),
                    },
                ],
            };
        } catch (error) {
            if (error instanceof ToolError) {
                // `isError: true` is a protocol-level signal. The client shows
                // the message to its model, which can then correct the call --
                // the same fail-forward contract the agent loop uses.
                return {
                    content: [{ type: "text" as const, text: error.message }],
                    isError: true,
                };
            }
            throw error;
        }
    },
);

// Top-level `await` works in ES modules. There is no `asyncio.run()` wrapper,
// because the event loop is already running before your first line executes.
await server.connect(new StdioServerTransport());

// stderr, not stdout. See the note at the top of the file.
process.stderr.write("kv-cache-planner MCP server ready on stdio\n");

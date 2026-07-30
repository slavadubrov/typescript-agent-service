# typescript-agent-service

A working agent service in a pnpm monorepo, written to be read by a Python ML
engineer who has never shipped TypeScript.

It is the companion repository for
[TypeScript for Python ML Engineers](https://slavadubrov.github.io/blog/2026/08/03/typescript-for-python-ml-engineers/).

Every file carries comments explaining **why** it looks the way it does, and
what the Python equivalent would be. The comments are the point. Read the
source in the order below and you will have seen the whole stack.

```text
typescript-agent-service/
├── apps/
│   ├── api/           Hono HTTP API, SSE agent streaming
│   ├── worker/        polls Postgres for long-running jobs
│   └── mcp/           MCP stdio server exposing one tool
├── packages/
│   ├── schemas/       Zod: env config, API contracts, tool schemas
│   ├── agent-core/    the agent loop (twice), tools, Drizzle storage
│   └── observability/ Pino logging, OpenTelemetry tracing
├── pnpm-workspace.yaml
└── package.json
```

## Run it with nothing installed

```bash
pnpm install
pnpm demo
```

`pnpm demo` runs the real HTTP handler, the real agent loop, and the real SSE
framing against a scripted model. No API key, no database, no Docker. Output:

```text
--- POST /v1/chat (SSE) ---
event: tool_call
data: {"type":"tool_call","callId":"call_1","toolName":"estimate_kv_cache","args":{"model":"llama-3.1-8b","seqLen":32768,"batchSize":16}}

event: tool_result
data: {"type":"tool_result","callId":"call_1","toolName":"estimate_kv_cache","ok":true,"result":{"model":"llama-3.1-8b","seqLen":32768,"batchSize":16,"kvCacheGiB":64},"durationMs":0}

event: text
data: {"type":"text","delta":"Llama-3.1-8B at 32k context "}
...
event: done
data: {"type":"done","stopReason":"stop","steps":2,"text":"Llama-3.1-8B at 32k context and batch 16 needs 64 GiB of KV cache."}

--- worker: capacity sweep ---
batch=  1  kv_cache=4.0 GiB
batch=  4  kv_cache=16.0 GiB
batch= 16  kv_cache=64.0 GiB
batch= 64  kv_cache=256.0 GiB
```

Then run the checks:

```bash
pnpm check     # tsc --noEmit, biome, vitest
```

## Run it for real

```bash
cp .env.example .env          # set OPENAI_API_KEY, or point OPENAI_BASE_URL at vLLM
pnpm db:up                    # Postgres in Docker
pnpm db:push                  # drizzle-kit syncs the schema
pnpm dev:api                  # http://localhost:8080
pnpm dev:worker               # in a second terminal
```

Stream an agent run:

```bash
curl -N -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -d '{"message":"How much KV cache for llama-3.1-70b at 32k context, batch 8?"}'
```

Queue a long job and poll it:

```bash
curl -X POST localhost:8080/v1/sweeps \
  -H 'content-type: application/json' \
  -d '{"model":"llama-3.1-70b","seqLen":32768,"batchSizes":[1,4,16]}'
# -> {"id":"...","status":"queued"}

curl localhost:8080/v1/runs/<id>
```

Talk to the MCP server without a client:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"estimate_kv_cache","arguments":{"model":"llama-3.1-70b","seqLen":8192,"batchSize":4}}}' \
  | pnpm -s mcp
```

## Reading order

| Read                                             | To learn                                                    |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `tsconfig.base.json`                             | which compiler flags matter and why                         |
| `packages/schemas/src/env.ts`                    | Zod as pydantic-settings; fail-fast configuration           |
| `packages/schemas/src/events.ts`                 | discriminated unions and exhaustive narrowing               |
| `packages/agent-core/src/tools.ts`               | one schema, three consumers; generic erasure                |
| `packages/agent-core/src/loop.ts`                | the agent loop with nothing hidden                          |
| `packages/agent-core/src/loop-ai-sdk.ts`         | the same loop on the Vercel AI SDK, for comparison          |
| `apps/api/src/app.ts`                            | Hono routes, Zod validation, SSE                            |
| `packages/agent-core/src/db/storage.ts`          | Drizzle, and `FOR UPDATE SKIP LOCKED` as a queue            |
| `apps/worker/src/index.ts`                       | the Celery-shaped part, without Celery                      |
| `apps/mcp/src/index.ts`                          | publishing a tool over MCP                                  |
| `packages/agent-core/src/loop.test.ts`           | testing an agent with no network and no key                 |
| `Dockerfile`                                     | pnpm in multi-stage builds, and where `node file.ts` stops  |

## Deliberate choices

**`/chat/completions`, not the Responses API.** Every OpenAI-compatible server
implements chat completions: vLLM, SGLang, Ollama, Together. Switching this
service to a model you host yourself is one environment variable. The Responses
API is a better API that only OpenAI speaks.

**The agent loop is written twice.** `loop.ts` is hand-rolled; `loop-ai-sdk.ts`
uses the Vercel AI SDK. They emit the same event stream, so you can read the
diff and decide for yourself what the framework is worth.

**Postgres is the queue.** No Redis, no BullMQ. `SELECT ... FOR UPDATE SKIP
LOCKED` is a correct queue in one table, and it is transactional with your
other writes. Add BullMQ when you need delayed jobs, repeatable schedules,
priorities, or rate limits — the same threshold at which you would move from a
database table to Celery.

**No build step in development.** `node apps/api/src/index.ts` runs the
TypeScript directly. `tsc --noEmit` in CI is what actually checks the types.
The container is the exception: Node refuses to strip types under
`node_modules`, and `pnpm deploy` puts the workspace packages there. See the
comment at the top of the `Dockerfile`.

## Verified on

Node 26.4.0 (engines allow >= 24), pnpm 11.15.1, TypeScript 7.0.2, Zod 4.4.3,
Hono 4.12.32, `ai` 7.0.42, `openai` 7.2.0, Drizzle ORM 0.45.2, Vitest 4.1.10,
Biome 2.5.6, `@modelcontextprotocol/sdk` 1.30.0, Postgres 17.

40 tests pass, including 4 integration tests against a real Postgres. The
runtime image is ~480 MB on `node:24-slim`; most of that is the OpenTelemetry
dependency tree.

## Licence

MIT.

/**
 * Configuration, validated once at process start.
 *
 * This is the `pydantic-settings` pattern. In Python you would write:
 *
 *     class Settings(BaseSettings):
 *         openai_api_key: str
 *         port: int = 8080
 *     settings = Settings()          # raises on a bad environment
 *
 * TypeScript has no runtime type information, so `process.env.PORT` is always
 * `string | undefined` no matter what you annotate it with. Zod is what turns
 * the untyped environment into a typed, checked object -- and it fails at
 * startup rather than at 03:00 inside a request handler.
 */

import { z } from "zod";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Port arrives as a string. `z.coerce.number()` is the equivalent of
    // pydantic's automatic str -> int coercion.
    PORT: z.coerce.number().int().positive().default(8080),

    // Any OpenAI-compatible endpoint works here: OpenAI, vLLM, Ollama,
    // Together. That is the whole reason this repo uses the /chat/completions
    // API rather than OpenAI's Responses API -- see packages/agent-core.
    //
    // The `protocol` constraint is not decoration. A bare `z.url()` accepts
    // "localhost:8000", because WHATWG URL parsing reads "localhost:" as the
    // scheme. The value then reaches the HTTP client and fails somewhere much
    // less informative. There is a test for exactly this in env.test.ts.
    OPENAI_BASE_URL: z.url({ protocol: /^https?$/ }).default("https://api.openai.com/v1"),
    OPENAI_API_KEY: z.string().min(1).default("not-set"),
    AGENT_MODEL: z.string().min(1).default("gpt-4.1-mini"),

    // Optional: when unset the API and worker run without a database and the
    // storage layer becomes a no-op. Keeps `pnpm demo` runnable on a laptop
    // with nothing installed.
    DATABASE_URL: z.string().optional(),

    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

    // Optional: when unset, tracing stays off instead of exporting into the
    // void. See packages/observability/src/tracing.ts.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
});

/**
 * `z.infer` reads a static type back out of a runtime schema. It is the
 * inverse of the pydantic mental model -- there you declare a class and get a
 * validator; here you declare a validator and get the class.
 *
 * There is exactly one source of truth either way.
 */
export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/**
 * Parse and cache the environment.
 *
 * Called once from each entry point. Deliberately NOT executed at module load:
 * a module that throws on import is impossible to unit-test and produces a
 * stack trace with no useful frames.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
    if (cached) return cached;

    // `safeParse` returns a result object instead of throwing. It is the
    // Result-style sibling of `parse`, and it is what you want whenever you
    // intend to format the error yourself.
    const parsed = EnvSchema.safeParse(source);

    if (!parsed.success) {
        // z.prettifyError renders the issue tree as readable lines, which
        // matters because the reader of this message is a deploy engineer
        // staring at a crash-looping container.
        throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
    }

    cached = parsed.data;
    return cached;
}

/** Test helper: forget the cached environment between test cases. */
export function resetEnv(): void {
    cached = undefined;
}

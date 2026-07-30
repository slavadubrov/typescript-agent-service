/**
 * OpenTelemetry tracing.
 *
 * Two things happen in this file, and they are worth separating in your head:
 *
 *   1. `startTracing()` installs the SDK. It must run before the modules it
 *      instruments are imported, which is why entry points call it first and
 *      why the import in index.ts sits above the others.
 *   2. `withSpan()` is the manual API you use in your own code. Auto
 *      instrumentation gives you HTTP and Postgres spans for free; it cannot
 *      know that "one agent step" is a unit worth measuring.
 *
 * If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, tracing stays off. A tracing
 * layer that silently retries into a dead collector is worse than none.
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | undefined;

export interface TracingOptions {
    serviceName: string;
    endpoint?: string | undefined;
}

/** Start the SDK. Returns false when tracing is disabled by configuration. */
export function startTracing({ serviceName, endpoint }: TracingOptions): boolean {
    if (!endpoint || sdk) return false;

    sdk = new NodeSDK({
        serviceName,
        traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    });

    sdk.start();

    // Node's `process.on("SIGTERM")` is the analogue of a signal handler in
    // Python. Without the flush, the last few spans of a Cloud Run container
    // die with it.
    process.once("SIGTERM", () => void sdk?.shutdown());

    return true;
}

export async function stopTracing(): Promise<void> {
    await sdk?.shutdown();
    sdk = undefined;
}

const tracer = trace.getTracer("agent-service");

/**
 * Run `fn` inside a span, recording exceptions and setting the status.
 *
 * The Python equivalent is a `with tracer.start_as_current_span(...)` block.
 * TypeScript has no `with`, so the callback is the block. This is the general
 * shape of every "context manager" you will miss: pass the body as a function.
 */
export async function withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
            return await fn(span);
        } catch (error) {
            // `catch` binds `unknown`, not `Error`. TypeScript refuses to
            // assume the thrown value is an Error because JavaScript lets you
            // throw a string, and people do.
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
        } finally {
            // `finally` runs on both paths. Forgetting `span.end()` leaks the
            // span and the trace never closes.
            span.end();
        }
    });
}

export type { Span };
export { SpanStatusCode };

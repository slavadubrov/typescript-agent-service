/**
 * Structured logging with Pino.
 *
 * Pino is the `structlog` of Node: it writes one JSON object per line and does
 * the serialisation on a separate thread when you ask it to. The important
 * difference from Python's `logging` is that there is no global root logger
 * you configure once and import everywhere by name. You create a logger and
 * pass it, or you create child loggers that inherit bound fields.
 */

import type { Logger } from "pino";
import { pino } from "pino";

export type { Logger };

let root: Logger | undefined;

export interface LoggerOptions {
    level?: string;
    /** Pretty-print instead of JSON. Only ever true on a developer laptop. */
    pretty?: boolean;
    name?: string;
}

/**
 * Build (once) the process-wide root logger.
 *
 * The `redact` list is the part people skip and then regret. Pino removes
 * those paths before serialisation, so an accidental
 * `log.info({ req }, "...")` cannot leak an Authorization header into a log
 * aggregator you do not control.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
    if (root) return root;

    const { level = "info", pretty = false, name = "agent-service" } = options;

    root = pino({
        name,
        level,
        redact: {
            paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'headers["x-api-key"]',
                "apiKey",
                "OPENAI_API_KEY",
                "*.apiKey",
            ],
            censor: "[redacted]",
        },
        // Pino writes `"level": 30`. Most backends prefer the word. This is
        // the one formatter worth overriding.
        formatters: {
            level: (label) => ({ level: label }),
        },
        // `pino-pretty` is a devDependency on purpose: production writes NDJSON
        // to stdout and lets the platform do the rendering.
        transport: pretty ? { target: "pino-pretty", options: { colorize: true } } : undefined,
    });

    return root;
}

/**
 * A child logger with permanently bound fields.
 *
 * `log.child({ runId })` is the equivalent of `structlog.bind(run_id=...)`.
 * Every line from the child carries the field, so you never thread the run id
 * through six call frames just to log it at the bottom.
 */
export function childLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
    return parent.child(bindings);
}

/** Test helper: drop the memoised root logger. */
export function resetLogger(): void {
    root = undefined;
}

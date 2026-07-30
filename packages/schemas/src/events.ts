/**
 * The wire contract between the agent loop and everything that watches it.
 *
 * The loop is an async generator that yields these events. The HTTP layer
 * turns them into Server-Sent Events, the tests assert on them as plain
 * objects, and the worker writes them to Postgres. One vocabulary, three
 * consumers, no translation layer in between.
 */

import { z } from "zod";

/**
 * A discriminated union: `z.discriminatedUnion` picks the branch by looking at
 * one literal field, exactly like a `match` on a tagged Python dataclass.
 *
 * Why a union rather than one loose `{type, data}` shape? Because TypeScript
 * narrows on the discriminant. Inside `if (event.type === "tool_call")` the
 * compiler knows `event.toolName` exists, and it knows `event.delta` does not.
 * You get exhaustiveness checking for free -- add a variant here and every
 * switch statement that forgot it stops compiling.
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
    /** One chunk of assistant text. Many of these per turn. */
    z.object({ type: z.literal("text"), delta: z.string() }),

    /** The model asked for a tool. Emitted before the tool runs. */
    z.object({
        type: z.literal("tool_call"),
        callId: z.string(),
        toolName: z.string(),
        args: z.unknown(),
    }),

    /** The tool finished. `ok: false` means the loop is feeding an error back
     *  to the model rather than crashing -- see agent-core/src/loop.ts. */
    z.object({
        type: z.literal("tool_result"),
        callId: z.string(),
        toolName: z.string(),
        ok: z.boolean(),
        result: z.unknown(),
        durationMs: z.number(),
    }),

    /** Terminal success. `stopReason` says why the loop ended. */
    z.object({
        type: z.literal("done"),
        stopReason: z.enum(["stop", "max_steps"]),
        steps: z.number().int(),
        text: z.string(),
    }),

    /** Terminal failure. The loop never throws past its own boundary. */
    z.object({ type: z.literal("error"), message: z.string() }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * Narrow an event by its tag without repeating the string literal everywhere.
 *
 * `Extract<AgentEvent, {type: T}>` is a conditional type: it filters the union
 * down to the member whose `type` matches. Python's closest equivalent is a
 * `TypeGuard`, but you would have to write one function per variant.
 */
export function isEvent<T extends AgentEvent["type"]>(
    event: AgentEvent,
    type: T,
): event is Extract<AgentEvent, { type: T }> {
    return event.type === type;
}

/**
 * The loop guard: a tool call that is exactly identical to one that already failed this turn, or identical to one
 * repeated a third time, is blocked. A local model that serves one request at a time can burn its whole slot
 * retrying a failing call, and the fix is a change of approach, not another attempt; the no-repeat rule in the
 * system prompt says the same thing the guard enforces. Outcomes are noted after each call and the count resets at
 * every new person's message, so a fresh request is a fresh chance to try the same thing. A call a restart cut off
 * is not a failure: checking what happened and running it again is how recovery works. A mutating call clears the
 * repeats of read-shaped tools, which can legitimately return something new after it. In memory on purpose: a
 * restart interrupts the loop anyway, and the guard re-arms on the next failure of the resumed run.
 */
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ConversationId, JsonObject, ToolRegistration } from "@earendil-works/pi-durable";

/** Identical calls allowed in one turn before the next is blocked. */
const REPEAT_LIMIT = 3;
/** Reads: after a mutating call, a repeat may legitimately return something new, so their repeats clear. */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Calls that can change what a later read finds. */
const MUTATING = new Set(["edit", "write", "bash", "powershell"]);
/** How many signatures one conversation keeps: more than any loop has. */
const MAX_SIGNATURES = 500;

type GuardState = {
    /** What marked the turn's start: its first user message, so a new message resets the counts. */
    userKey: string;
    /** How often each call (tool + arguments) has run in this turn, by signature. */
    calls: Map<string, number>;
    /** Signatures whose newest run failed. */
    failed: Set<string>;
};

/** The call's key: its tool and its arguments, object keys sorted so `a, b` and `b, a` are the same call. */
export function signatureOf(name: string, args: unknown): string {
    const norm = (value: unknown): unknown =>
        value !== null && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                  Object.keys(value as Record<string, unknown>)
                      .sort()
                      .map((key) => [key, norm((value as Record<string, unknown>)[key])]),
              )
            : value;

    return `${name}:${JSON.stringify(norm(args))}`;
}

/**
 * The arguments the harness will run a raw call with: prepared by the tool's wrapper, then validated and coerced
 * against its schema. `beforeTool` sees that form, while `afterTool` is given the model's raw call, so the guard
 * re-derives the form there: a call the model wrote slightly wrong - a JSON string of an object, a string where a
 * number belongs - signs as the clean identical call, and its repeats reach the limit like any other's.
 */
export function preparedArguments(call: ToolCall, tool: ToolRegistration | undefined): unknown {
    if (tool === undefined) {
        return call.arguments;
    }

    // The call already ran, so this re-runs the same pure prepare and validation the harness ran: a throw here is
    // impossible for a call that settled, and the fallback keeps the guard's old, raw-arguments domain.
    try {
        const prepared =
            tool.prepareArguments === undefined
                ? call.arguments
                : tool.prepareArguments(call.arguments);

        return validateToolArguments(tool, { ...call, arguments: prepared as JsonObject });
    } catch {
        return call.arguments;
    }
}

/** What the guard remembers, by conversation: one guard the app's extensions share. */
export class LoopGuard {
    readonly #state = new Map<ConversationId, GuardState>();

    #stateOf(conversationId: ConversationId): GuardState {
        let state = this.#state.get(conversationId);

        if (state === undefined) {
            state = { userKey: "", calls: new Map(), failed: new Set() };
            this.#state.set(conversationId, state);
        }

        return state;
    }

    /** A request is about to go out: when it starts with a user message the guard has not seen, the turn resets. */
    onRequest(messages: readonly Message[], conversationId: ConversationId): void {
        let lastUser = -1;
        let text = "";

        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index]!;

            if (message.role === "user") {
                lastUser = index;
                text =
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
                              .join("");
                break;
            }
        }

        if (lastUser < 0) {
            return;
        }

        const key = `${lastUser}:${text.slice(0, 200)}`;
        const state = this.#stateOf(conversationId);

        if (state.userKey === key) {
            return;
        }

        state.userKey = key;
        state.calls = new Map();
        state.failed = new Set();
    }

    /** A call has run: count it, remember that it failed (or that the latest one no longer does), and clear the
     * repeats of reads after a mutation. A call a restart cut off is not counted at all. */
    noteCall(
        conversationId: ConversationId,
        name: string,
        args: unknown,
        { isError, interrupted }: { isError: boolean; interrupted: boolean },
    ): void {
        if (interrupted) {
            return;
        }

        const state = this.#stateOf(conversationId);
        const signature = signatureOf(name, args);
        const runs = (state.calls.get(signature) ?? 0) + 1;

        state.calls.set(signature, runs);

        if (state.calls.size > MAX_SIGNATURES) {
            state.calls = new Map();
            state.failed = new Set();
        }

        if (isError) {
            state.failed.add(signature);
        } else {
            state.failed.delete(signature);
        }

        if (MUTATING.has(name)) {
            for (const key of [...state.calls.keys()]) {
                if (READ_TOOLS.has(key.split(":", 1)[0] ?? "")) {
                    state.calls.delete(key);
                    state.failed.delete(key);
                }
            }
        }
    }

    /** Why this call should not run, as a remark the model sees; undefined when it should. */
    blocked(conversationId: ConversationId, name: string, args: unknown): string | undefined {
        const state = this.#stateOf(conversationId);
        const prior = state.calls.get(signatureOf(name, args)) ?? 0;

        if (prior < REPEAT_LIMIT - 1) {
            return undefined;
        }

        return state.failed.has(signatureOf(name, args))
            ? `you already ran ${name} with exactly these arguments and it failed, and you ran it ${prior} times this turn. Do not run it again: change the arguments, use a different tool or file, or answer now with what you have and say what is still unknown`
            : `you already ran ${name} with exactly these arguments ${prior} times this turn; the result will not change. Do something different, or answer now with what you have`;
    }
}

/**
 * Prune before summarising. When compaction selects the messages to summarise, the pruner's `beforeCompact` hook
 * first tries to replace them with a note that costs no model call: most tool output becomes a one-line placeholder,
 * the last `pruneKeepLast` results stay in full, a read of a file that is read again is stale and goes, and a tool
 * call repeated in a loop collapses to one line. Only when the note would still leave the context over its limit
 * does the LLM summary run instead - which for PiP is PiP's own (`pip-compact.ts`), so PiP is left to it. Masking
 * halves the cost of a turn and matches or beats LLM summarization on solve rate (The Complexity Trap,
 * arXiv:2508.21433), and it keeps the conversation's KV prefix intact in the common case.
 */
import type { Context } from "@earendil-works/chord";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
    type ContextView,
    type ConversationId,
    DEFAULT_COMPACTION_POLICY,
    type HookApi,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { pruneSettings, type PruneSettings } from "./compaction.ts";
import { clip } from "./fence.ts";

/** The line the note starts with; an older note is recognised and carried over, not re-masked. */
export const PRUNED_HEAD = "[Pruned]";
/** What a model-written summary starts with (Pi Durable's and PiP's); those are kept whole, not re-masked. */
const NOTES_HEAD =
    "The conversation history before this point was compacted into the following summary:";

/** How much of one message the note keeps. */
const USER_TEXT_CHARS = 2000;
const ASSISTANT_TEXT_CHARS = 2000;
const ERROR_CHARS = 800;
/** A kept-in-full result, clipped: a 50 KB read is a mask target, not a note. */
const FULL_KEEP_CHARS = 16_000;
/** An older note or summary, carried into the new one. */
const EARLIER_NOTES_CHARS = 4000;
/** A call seen this many times already is a loop: from the next on it is one line. */
const REPEATS_BEFORE_MASK = 2;
/** A note this small is always worth taking over a summary the model writes for a price. */
const TINY_NOTE_TOKENS = 2048;

export type PruneOptions = {
    /** How many of the range's tool results stay in full. */
    keepLast: number;
    /** Paths the kept part reads or edits again: an older read of one is stale. */
    supersededPaths?: ReadonlySet<string>;
};

export type PrunedSummary = {
    summary: string;
    chars: number;
    /** `chars / 4`, the meter's scale. */
    tokens: number;
    /** Range minus note, in characters: the room the prune frees. */
    saved: number;
};

/** One line of the call's arguments, the way a result's placeholder names the call. */
const oneLine = (text: string, max = 200): string => {
    const flat = text.trim().replace(/[\r\n]+/g, " ");

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const textOf = (content: string | readonly { type: string; text?: string }[]): string =>
    typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");

/** The file a read or edit call acts on, for stale-read detection. */
const pathOf = (call: { name: string; args: unknown }): string | undefined => {
    if (call.args === null || typeof call.args !== "object") {
        return undefined;
    }

    const path = (call.args as { path?: unknown }).path;

    return call.name === "read" || call.name === "edit" || call.name === "write"
        ? typeof path === "string"
            ? path
            : undefined
        : undefined;
};

type PendingCall = {
    name: string;
    args: unknown;
    argsLine: string;
    signature: string;
    repeated: boolean;
};
type ResultRef = { message: ToolResultMessage; call: PendingCall };

/** The range's messages as the note reads them: what each side said, and each call one line. */
export function pruneSummary(
    messages: readonly Message[],
    options: PruneOptions,
): PrunedSummary | undefined {
    if (messages.length === 0) {
        return undefined;
    }

    // One pass collects the note's lines, the calls in order, and the results they produced: a cut never strands a
    // call from its result, so they pair by order.
    type Item = { kind: "line"; text: string } | { kind: "result"; index: number };
    const items: Item[] = [];
    const results: ResultRef[] = [];
    const pending: PendingCall[] = [];
    const repeats = new Map<string, number>();

    for (const message of messages) {
        if (message.role === "user") {
            const text = textOf(message.content);

            if (text === "") {
                continue;
            }

            // A model-written summary stays whole; an older prune note is carried on, clipped; a person's words, clipped.
            const carried =
                text.startsWith(NOTES_HEAD) || text.startsWith(PRUNED_HEAD)
                    ? "Earlier notes"
                    : "Message";
            const limit = carried === "Earlier notes" ? EARLIER_NOTES_CHARS : USER_TEXT_CHARS;

            items.push({ kind: "line", text: `[${carried}]: ${clip(text, limit)}` });
        } else if (message.role === "assistant") {
            let original = 0;

            for (const block of message.content) {
                if (block.type === "text") {
                    original += block.text.length;
                    const said = block.text.trim();

                    if (said !== "") {
                        items.push({
                            kind: "line",
                            text: `[Pi]: ${clip(said, ASSISTANT_TEXT_CHARS)}`,
                        });
                    }
                } else if (block.type === "thinking") {
                    original += block.thinking.length;
                } else if (block.type === "toolCall") {
                    const argsLine = oneLine(JSON.stringify(block.arguments ?? {}));

                    original += argsLine.length;
                    const signature = `${block.name}:${argsLine}`;
                    const seen = (repeats.get(signature) ?? 0) + 1;

                    repeats.set(signature, seen);
                    const repeated = seen > REPEATS_BEFORE_MASK;

                    items.push({
                        kind: "line",
                        text: repeated
                            ? `- [Pi called ${block.name} again]`
                            : `- [Pi called ${block.name} ${argsLine}]`,
                    });
                    pending.push({
                        name: block.name,
                        args: block.arguments,
                        argsLine,
                        signature,
                        repeated,
                    });
                }
            }
        } else if (message.role === "toolResult") {
            const call = pending.shift() ?? {
                name: message.toolName,
                args: undefined,
                argsLine: "",
                signature: message.toolName,
                repeated: false,
            };

            results.push({ message, call });
            items.push({ kind: "result", index: results.length - 1 });
        } else {
            // System and other roles carry no note material.
        }
    }

    if (results.length === 0) {
        // Nothing tool-shaped to mask: the note is not smaller than what it replaces.
        return undefined;
    }

    // A read is stale when the same path is read again later in the range, or again in the kept part.
    const lastTouch = new Map<string, number>();

    for (let index = results.length - 1; index >= 0; index--) {
        const path = pathOf(results[index]!.call);

        if (path !== undefined && !lastTouch.has(path)) {
            lastTouch.set(path, index);
        }
    }

    const staleOf = (index: number): boolean => {
        const path = pathOf(results[index]!.call);

        return (
            path !== undefined &&
            (lastTouch.get(path) !== index || options.supersededPaths?.has(path) === true)
        );
    };

    // The last `keepLast` successful, fresh results stay in full; errors are short and stay in their place.
    const inFull = new Set<number>();
    let full = 0;

    for (let index = results.length - 1; index >= 0 && full < options.keepLast; index--) {
        const { message, call } = results[index]!;

        if (message.isError || call.repeated || staleOf(index)) {
            continue;
        }

        inFull.add(index);
        full++;
    }

    const note: string[] = [
        `[Pruned] To save context, ${messages.length} older messages were compressed into this note. Most tool ` +
            `output is a one-line placeholder${
                inFull.size > 0 ? `, the newest ${inFull.size} results stay in full below` : ""
            }. Re-read a file or re-run a command to see what was masked; a read marked stale was of a version a ` +
            `later read replaced.`,
    ];

    for (const item of items) {
        if (item.kind === "line") {
            note.push(item.text);

            continue;
        }

        const { message, call } = results[item.index]!;
        const output = textOf(message.content);

        if (message.isError) {
            note.push(`- [${call.name} ${call.argsLine} failed] ${clip(output, ERROR_CHARS)}`);
        } else if (inFull.has(item.index)) {
            // Re-emitted below, in full.
        } else {
            const stale = staleOf(item.index) ? ", stale" : "";
            const size = oneLine(`${output.length} chars of output`, 40);

            note.push(`- [${call.name} ${call.argsLine}${stale} → masked: ${size}]`);
        }
    }

    const keptFull = results
        .map((result, index) => ({ result, index }))
        .filter(({ index }) => inFull.has(index));

    if (keptFull.length > 0) {
        note.push("", "[Full output of the newest tool results]");

        for (const { result } of keptFull) {
            const { message, call } = result;

            note.push(
                `[${call.name} ${call.argsLine}]`,
                clip(textOf(message.content), FULL_KEEP_CHARS),
            );
        }
    }

    const summary = note.join("\n");
    let original = 0;

    for (const message of messages) {
        original += textOf(message.content).length;

        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall") {
                    original += JSON.stringify(block.arguments ?? {}).length;
                }
            }
        }
    }

    return {
        summary,
        chars: summary.length,
        tokens: Math.ceil(summary.length / 4),
        saved: original - summary.length,
    };
}

/**
 * Whether a pruned note is worth taking over a summary a model writes for a price: a tiny note always, otherwise
 * the note must be no bigger than half of what it replaces.
 */
export function worthPruning(pruned: PrunedSummary): boolean {
    return pruned.tokens < TINY_NOTE_TOKENS || pruned.saved >= pruned.chars;
}

/** The file paths the kept part (at or after `firstKept`) reads, edits, or writes. */
export function touchedPaths(view: ContextView, firstKept: number): Set<string> {
    const paths = new Set<string>();
    let past = false;

    for (let index = 0; index < view.entries.length; index++) {
        if (view.entries[index]!.id === firstKept) {
            past = true;
        }

        if (!past) {
            continue;
        }

        for (const message of view.contributions[index] ?? []) {
            if (message.role !== "assistant") {
                continue;
            }

            for (const block of message.content) {
                if (block.type === "toolCall") {
                    const path = pathOf({ name: block.name, args: block.arguments });

                    if (path !== undefined) {
                        paths.add(path);
                    }
                }
            }
        }
    }

    return paths;
}

/** The kept part's tokens, from `firstKept` on. */
export function tokensAfter(view: ContextView, firstKept: number): number {
    let tokens = 0;
    let past = false;

    for (let index = 0; index < view.entries.length; index++) {
        if (view.entries[index]!.id === firstKept) {
            past = true;
        }

        if (!past) {
            continue;
        }

        for (const message of view.contributions[index] ?? []) {
            tokens += estimateMessageTokens(message);
        }
    }

    return tokens;
}

/** The prompt of the newest response that measured it; 0 when none has. */
export function measuredPromptTokens(view: ContextView): number {
    for (let index = view.messages.length - 1; index >= 0; index--) {
        const message = view.messages[index]!;

        if (message.role !== "assistant") {
            continue;
        }

        const usage = message.usage as
            { input?: number; cacheRead?: number; cacheWrite?: number } | undefined;
        const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);

        if (prompt > 0) {
            return prompt;
        }
    }

    return 0;
}

/**
 * A session's compaction, taken from `beforeCompact`: the pruned note when it frees enough room, otherwise no
 * decision, so the LLM summary (Pi Durable's, or PiP's own) runs. Undefined for PiP and when the pruner is off.
 */
export class Pruner {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The settings the note is written with. */
    settings(): PruneSettings {
        return pruneSettings(this.#app.settings);
    }

    async summarize(
        compaction: {
            reason: string;
            messages: readonly Message[];
            firstKept: number;
            instructions?: string;
        },
        api: HookApi,
        context: Context,
    ): Promise<{ summary: string } | undefined> {
        if (this.#app.pip.ownerOf(api.conversationId) !== undefined) {
            return undefined;
        }

        const settings = this.settings();

        if (!settings.pruneToolOutput) {
            return undefined;
        }

        const view = await (await this.#app.conversation(api.conversationId))!.context(context);
        const pruned = pruneSummary(compaction.messages, {
            keepLast: settings.pruneKeepLast,
            supersededPaths: touchedPaths(view, compaction.firstKept),
        });

        if (pruned === undefined || !worthPruning(pruned)) {
            return undefined;
        }

        const kept = tokensAfter(view, compaction.firstKept);
        const prompt = measuredPromptTokens(view);
        const policy = {
            ...DEFAULT_COMPACTION_POLICY,
            ...this.#app.settings.getCompactionSettings(),
        };
        const window = await this.#window(api.conversationId);

        // Still over once the note is in: the LLM summary, which shrinks harder, must run.
        if (window > 0 && prompt + pruned.tokens + kept >= window - policy.reserveTokens) {
            return undefined;
        }

        if (window <= 0 && pruned.tokens > 8192) {
            return undefined;
        }

        this.#app.log(
            `Pruned ${compaction.messages.length} messages into ${pruned.tokens} tokens of note without a summary call`,
        );

        return { summary: pruned.summary };
    }

    /** The context window the policy's threshold is measured against; 0 when the model has none (or is unknown). */
    async #window(id: ConversationId): Promise<number> {
        const ref = (await this.#app.agentState(id))?.model;

        if (ref === undefined) {
            return 0;
        }

        return this.#app.models.getModel(ref.provider, ref.modelId)?.contextWindow ?? 0;
    }
}

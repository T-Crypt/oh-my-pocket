/**
 * Where a conversation's context goes: the system prompt by section, each tool's schema, and the history by kind (what
 * people wrote, Pi's answers, its reasoning, its tool calls, and each tool's results). Counts are characters over four,
 * scaled to the newest response's measured prompt when there is one, so the rows add up to what the provider counted.
 * This is how a change to a prompt, a tool, or a skill list is measured: the row it touches, before and after.
 */
import type { Message, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";

export type ContextRow = {
    /** `system` (prompt sections), `tools` (schemas), or `history`. */
    group: "system" | "tools" | "history";
    /** A section's name, a tool's name, or a kind of history such as `user` or `result: bash`. */
    name: string;
    tokens: number;
};

export type ContextMeter = {
    rows: ContextRow[];
    /** The rows' sum. */
    tokens: number;
    /** Whether the counts are scaled to a measured prompt, rather than estimated from characters alone. */
    measured: boolean;
};

const CHARS_PER_TOKEN = 4;

type Usage = { input?: number; cacheRead?: number; cacheWrite?: number };

function text(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    return Array.isArray(content)
        ? content
              .map((part: { type?: string; text?: string }) =>
                  part.type === "text" ? (part.text ?? "") : "",
              )
              .join("")
        : "";
}

/** Characters per row, history in the order it first appears. */
function chars(
    messages: readonly Message[],
): Map<string, { group: ContextRow["group"]; chars: number }> {
    const rows = new Map<string, { group: ContextRow["group"]; chars: number }>();

    const add = (group: ContextRow["group"], name: string, count: number) => {
        if (count <= 0) {
            return;
        }

        const key = `${group}\u0000${name}`;
        const row = rows.get(key) ?? { group, chars: 0 };

        row.chars += count;
        rows.set(key, row);
    };

    const system = getCurrentSystemMessage(messages);

    if (system !== undefined) {
        add("system", "base", text(system.content).length);

        for (const [name, section] of Object.entries(system.sections ?? {})) {
            add("system", name, section?.length ?? 0);
        }

        for (const tool of system.toolsAdded ?? ([] as Tool[])) {
            add("tools", tool.name, JSON.stringify(toToolDeclaration(tool)).length);
        }
    }

    for (const message of messages) {
        if (message.role === "user") {
            add("history", "user", text(message.content).length);
        } else if (message.role === "assistant") {
            for (const part of message.content) {
                if (part.type === "text") {
                    add("history", "answers", part.text.length);
                } else if (part.type === "thinking") {
                    add("history", "reasoning", part.thinking.length);
                } else if (part.type === "toolCall") {
                    add(
                        "history",
                        `call: ${part.name}`,
                        JSON.stringify(part.arguments ?? {}).length,
                    );
                }
            }
        } else if (message.role === "toolResult") {
            add("history", `result: ${message.toolName}`, text(message.content).length);
        }
    }

    return rows;
}

/**
 * The context of `messages` (a conversation's model context for its next request), by row. The newest response that
 * measured its prompt sets the scale: the characters it was sent come to the tokens it counted.
 */
export function contextMeter(messages: readonly Message[]): ContextMeter {
    let scale = 1 / CHARS_PER_TOKEN;
    let measured = false;

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]!;

        if (message.role !== "assistant") {
            continue;
        }

        const usage = message.usage as Usage | undefined;
        const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
        const sent = [...chars(messages.slice(0, index)).values()].reduce(
            (sum, row) => sum + row.chars,
            0,
        );

        // An answer cut off before its usage came measured nothing: an older one sets the scale.
        if (prompt > 0 && sent > 0) {
            scale = prompt / sent;
            measured = true;
            break;
        }
    }

    const rows = [...chars(messages)].map(([key, row]) => ({
        group: row.group,
        name: key.slice(key.indexOf("\u0000") + 1),
        tokens: Math.round(row.chars * scale),
    }));

    return { rows, tokens: rows.reduce((sum, row) => sum + row.tokens, 0), measured };
}

/**
 * Todo: a task list the model keeps for work of several steps, one item in progress at a time. A small model on a
 * long job forgets a step, or stops after the first; writing the steps down and ticking them off keeps it on the
 * plan, and the list survives compaction and restarts because it is stored with the session, not only in the
 * transcript. Each update sends the whole list. After DSH's todo tool.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type TodoItem, TodoDoc } from "../docs.ts";
import type { PocketHost } from "../host.ts";

const MAX_ITEMS = 20;
const MAX_TEXT = 200;
const MARKS: Record<TodoItem["status"], string> = { pending: "[ ]", doing: "[>]", done: "[x]" };

/** The list as the model reads it. */
export function renderTodo(items: readonly TodoItem[]): string {
    if (items.length === 0) {
        return "The task list is empty.";
    }

    const done = items.filter((item) => item.status === "done").length;
    const next = items.find((item) => item.status !== "done");

    return [
        `Tasks (${done}/${items.length} done):`,
        ...items.map((item) => `${MARKS[item.status]} ${item.text}`),
        next === undefined ? "All done." : `Next: ${next.text}`,
    ].join("\n");
}

export default function createTodo(_host: PocketHost) {
    const todo = defineTool({
        name: "todo",
        description:
            "Your task list for this session. For work of three steps or more, write the steps first, set one to doing " +
            "before you start it, and set it to done as soon as it is finished. Send the whole list each time; call " +
            "without items to see it.",
        parameters: Type.Object({
            items: Type.Optional(
                Type.Array(
                    Type.Object({
                        text: Type.String(),
                        status: Type.Union([
                            Type.Literal("pending"),
                            Type.Literal("doing"),
                            Type.Literal("done"),
                        ]),
                    }),
                    { description: "The whole list, in order." },
                ),
            ),
        }),
        // Replacing the list with the same list again changes nothing.
        replay: "safe",
        execute: async (args, api, context) => {
            const items = args.items as TodoItem[] | undefined;

            if (items !== undefined) {
                if (items.length > MAX_ITEMS) {
                    throw new Error(`At most ${MAX_ITEMS} items: merge small steps.`);
                }

                if (items.filter((item) => item.status === "doing").length > 1) {
                    throw new Error("Only one item may be doing at a time.");
                }
            }

            const list = await api.commit(async (tx) => {
                const state = await tx.doc(TodoDoc, api.conversationId);

                if (items !== undefined) {
                    state.items = items.map((item) => ({
                        text: item.text.trim().slice(0, MAX_TEXT),
                        status: item.status,
                    }));
                }

                return state.items.map((item) => ({ ...item }));
            }, context);

            return { content: [{ type: "text" as const, text: renderTodo(list) }] };
        },
    });

    return defineExtension({ name: "pocket-todo", tools: [todo] });
}

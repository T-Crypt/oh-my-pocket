/**
 * Read first: the model may change a file only after reading it, and only while it is still as it was read. A small
 * model writes over a file it never opened, or edits from what it remembers of a file that has changed since (a
 * person, a formatter, or its own bash command changed it); both lose work. Writing a new file needs no read. A
 * subagent forked from this conversation knows what it read. After DSH's fs-observation-policy; like it, what was read
 * is not kept across a restart, so after one the model reads the file again.
 */
import { statSync } from "node:fs";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

/** Conversations whose reads are kept: the oldest is forgotten past this many. */
const MAX_CONVERSATIONS = 200;
/** How many forks up a conversation looks for its parents' reads. */
const MAX_ANCESTORS = 5;

/** A file as it was: its modification time and size, or undefined when it does not exist. */
function stampOf(path: string): string | undefined {
    try {
        const stat = statSync(path);

        return `${stat.mtimeMs}:${stat.size}`;
    } catch {
        return undefined;
    }
}

export default function createReadFirst(_host: PocketHost) {
    const seen = new Map<ConversationId, Map<string, string>>();

    const remember = (id: ConversationId, path: string) => {
        const stamp = stampOf(path);

        if (stamp === undefined) {
            return;
        }

        let files = seen.get(id);

        if (files === undefined) {
            files = new Map();
            seen.set(id, files);

            if (seen.size > MAX_CONVERSATIONS) {
                seen.delete(seen.keys().next().value!);
            }
        }

        files.set(path, stamp);
    };

    type Api = Parameters<ToolRegistration["execute"]>[1];

    /** The absolute path a call names, as the tool resolves it; undefined when it cannot be resolved. */
    const resolve = async (
        api: Api,
        path: string,
        context: Parameters<ToolRegistration["execute"]>[2],
    ) => {
        const named = path.startsWith("@") ? path.slice(1) : path;
        const found = await api.env?.absolutePath(named, context);

        return found?.ok === true ? found.value : undefined;
    };

    /** What this conversation, or one it was forked from, last read of `path`. */
    const lastRead = async (
        api: Api,
        path: string,
        context: Parameters<ToolRegistration["execute"]>[2],
    ) => {
        let id: ConversationId | undefined = api.conversationId;

        for (let depth = 0; id !== undefined && depth <= MAX_ANCESTORS; depth++) {
            const stamp = seen.get(id)?.get(path);

            if (stamp !== undefined) {
                return stamp;
            }

            const current: ConversationId = id;

            id = (await api.commit(async (tx) => tx.conversation(current), context))?.parent
                ?.conversationId;
        }

        return undefined;
    };

    const tools = CodingTools.tools ?? [];
    const named = (name: string) =>
        tools.find((tool) => tool.name === name) as ToolRegistration | undefined;
    const read = named("read");
    const changers = ["write", "edit"].flatMap((name) => named(name) ?? []);

    return defineExtension({
        name: "pocket-read-first",
        wraps: [
            ...(read === undefined
                ? []
                : [
                      wrapTool(read, (tool) => ({
                          ...tool,
                          execute: async (args, api, context) => {
                              const result = await tool.execute(args, api, context);
                              const path = await resolve(
                                  api,
                                  (args as { path: string }).path,
                                  context,
                              );

                              if (result.isError !== true && path !== undefined) {
                                  remember(api.conversationId, path);
                              }

                              return result;
                          },
                      })),
                  ]),
            ...changers.map((changer) =>
                wrapTool(changer, (tool) => ({
                    ...tool,
                    execute: async (args, api, context) => {
                        const given = (args as { path: string }).path;
                        const path = await resolve(api, given, context);

                        if (path === undefined) {
                            return tool.execute(args, api, context);
                        }

                        const now = stampOf(path);

                        if (now !== undefined) {
                            const before = await lastRead(api, path, context);

                            if (before === undefined) {
                                throw new Error(
                                    `${given} exists and you have not read it in this session. Read it first, then change it.`,
                                );
                            }

                            if (before !== now) {
                                throw new Error(
                                    `${given} changed since you last read it. Read it again, then change it.`,
                                );
                            }
                        }

                        const result = await tool.execute(args, api, context);

                        // What the model wrote is what it knows: it may change the file again without reading it.
                        if (result.isError !== true) {
                            remember(api.conversationId, path);
                        }

                        return result;
                    },
                })),
            ),
        ],
    });
}

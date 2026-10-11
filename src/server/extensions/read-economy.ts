/**
 * Read economy: a read without an explicit limit returns at most five hundred lines, and the result carries a
 * structural map of the part it did not read (how many lines remain and where the sections sit), so a model that
 * opens a big file knows what it did not read and how to come back for it. The map is appended to the result by
 * this wrapper, which reads the unread tail through the conversation's environment; a read that says how much to
 * read keeps its own limit and still gets the map.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { outlineRegion, readWindow, READ_ECONOMY_LIMIT } from "../read-economy.ts";
import { repairToolArguments } from "../tool-repair.ts";
import type { PocketHost } from "../host.ts";

export default function createReadEconomy(host: PocketHost) {
    const read = (CodingTools.tools ?? []).find((tool) => tool.name === "read") as ToolRegistration | undefined;

    if (read === undefined) {
        return defineExtension({ name: "pocket-read-economy" });
    }

    return defineExtension({
        name: "pocket-read-economy",
        wraps: [
            wrapTool(read, (tool) => ({
                ...tool,
                // A read that did not say how much to read gets the default cap; one that did, keeps its own.
                // The repair (a JSON string where the object belongs) runs here too, because the harness asks
                // only the outermost wrapper to prepare the arguments, and this wrapper is read's outermost one.
                prepareArguments: (args: unknown) => {
                    const repaired = repairToolArguments(args, tool.parameters);

                    if (typeof repaired !== "object" || repaired === null || Array.isArray(repaired)) {
                        return repaired as never;
                    }

                    const { limit, ...rest } = repaired as Record<string, unknown>;

                    return (limit === undefined ? { ...rest, limit: READ_ECONOMY_LIMIT } : repaired) as never;
                },
                execute: async (args, api, context) => {
                    const input = args as { path: string; offset?: number; limit?: number };
                    const result = await tool.execute(args, api, context);

                    if (result.isError) {
                        return result;
                    }

                    const env = host.envFor(api.conversationId);
                    const located = await env.absolutePath(input.path, context);

                    if (!located.ok) {
                        return result;
                    }

                    const opened = await env.openBinaryReader(located.value, undefined, context);

                    if (!opened.ok) {
                        return result;
                    }

                    const reader = opened.value;
                    const counted = await reader.scanLines({ startLine: 0 }, context);

                    if (!counted.ok) {
                        await reader.close(context);
                        return result;
                    }

                    // A trailing newline ends the last line; the empty stretch after it is not a line.
                    let total = counted.value.newlines + 1;

                    if (counted.value.lastLineStart === counted.value.end && counted.value.lastLineStart > counted.value.start) {
                        total--;
                    }
                    const start = Math.max(0, (input.offset ?? 1) - 1);

                    // How far the read reached: user-limited reads reach as far as their limit, unlimited ones
                    // as far as the tool reported; past the end of the file there is nothing left to map.
                    const end =
                        input.limit !== undefined
                            ? start + Math.min(input.limit, Math.max(0, total - start))
                            : readWindow(
                                  (result.diagnostics ?? []).map((each) => each.message).join("\n"),
                              )?.end;

                    if (end === undefined || end >= total) {
                        await reader.close(context);
                        return result;
                    }

                    const tail = await reader.scanLines({ startLine: end }, context);

                    if (!tail.ok) {
                        await reader.close(context);
                        return result;
                    }

                    const range = tail.value;
                    const chunk = await reader.read(range.start, Math.max(0, range.end - range.start), context);

                    await reader.close(context);

                    if (!chunk.ok) {
                        return result;
                    }

                    const outline = outlineRegion(new TextDecoder().decode(chunk.value), end + 1, total);

                    return {
                        ...result,
                        content: [...(result.content ?? []), { type: "text" as const, text: outline }],
                    };
                },
            })),
        ],
    });
}

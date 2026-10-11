/**
 * Read economy: a read without an explicit limit returns at most five hundred lines, and the result carries a
 * structural map of the part it did not read (how many lines remain and where the sections sit), so a model that
 * opens a big file knows what it did not read and how to come back for it. The map is added to the result by this
 * wrapper, like the tool's own truncation remarks: as an info diagnostic, which the harness renders after it bounds
 * the content, so it reaches the model even on a read whose text fills the window. It starts at the line the tool's
 * own report says the read stopped at - where its line or byte cap really cut the read, not the limit injected here
 * - and it reads only a bounded slice of the unread tail, so a multi-gigabyte file costs a bounded scan and a
 * bounded decode, and the map says when its budget stopped short. A read that says how much to read keeps its own
 * limit and still gets the map.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import {
    outlineRegion,
    OUTLINE_BYTE_BUDGET,
    OUTLINE_LINE_BUDGET,
    readWindow,
    READ_ECONOMY_LIMIT,
} from "../read-economy.ts";
import { repairToolArguments } from "../tool-repair.ts";
import type { PocketHost } from "../host.ts";

export default function createReadEconomy(host: PocketHost) {
    const read = (CodingTools.tools ?? []).find((tool) => tool.name === "read") as
        ToolRegistration | undefined;

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

                    if (
                        typeof repaired !== "object" ||
                        repaired === null ||
                        Array.isArray(repaired)
                    ) {
                        return repaired as never;
                    }

                    const { limit, ...rest } = repaired as Record<string, unknown>;

                    return (
                        limit === undefined ? { ...rest, limit: READ_ECONOMY_LIMIT } : repaired
                    ) as never;
                },
                execute: async (args, api, context) => {
                    const input = args as { path: string };
                    const result = await tool.execute(args, api, context);

                    if (result.isError) {
                        return result;
                    }

                    // Where the read really stopped: the line the tool's own report names, from its line and byte
                    // caps - the injected limit only bounded how far it was asked to go, where the caps cut it is
                    // where the file continues. No report, or a first line too big for the byte cap, means there is
                    // no line to map from, and no total to map against.
                    const window = readWindow(
                        (result.diagnostics ?? []).map((each) => each.message).join("\n"),
                    );

                    if (window?.end === undefined || window.total === undefined) {
                        return result;
                    }

                    if (window.end >= window.total) {
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

                    try {
                        // The map covers what its budgets reach of the tail: the lines after the stop, within the
                        // line budget, and at most a megabyte of their bytes. The scan streams the file in bounded
                        // chunks; only the budgeted slice is read, decoded and line-split.
                        const info = await reader.info(context);

                        if (!info.ok) {
                            return result;
                        }

                        const tail = await reader.scanLines(
                            {
                                startLine: window.end,
                                endLine: window.end + OUTLINE_LINE_BUDGET,
                            },
                            context,
                        );

                        if (!tail.ok) {
                            return result;
                        }

                        const range = tail.value;
                        const length = Math.min(
                            Math.max(0, range.end - range.start),
                            OUTLINE_BYTE_BUDGET,
                        );

                        if (length === 0) {
                            return result;
                        }

                        const chunk = await reader.read(range.start, length, context);

                        if (!chunk.ok) {
                            return result;
                        }

                        const text = new TextDecoder().decode(chunk.value);
                        const fromLine = window.end + 1;
                        const newlines = text.length === 0 ? 0 : text.split("\n").length - 1;
                        const mappedTo = fromLine + newlines - (text.endsWith("\n") ? 1 : 0);

                        // A scan that ran to the end of the file mapped the whole rest of it, whatever the budgets
                        // did: the map then reaches the file's last line as the tool's report counts it.
                        const coveredTo =
                            range.end >= info.value.size
                                ? window.total
                                : Math.max(mappedTo, fromLine);

                        if (coveredTo <= window.end) {
                            return result;
                        }

                        const outline = outlineRegion(text, fromLine, window.total, coveredTo);

                        return {
                            ...result,
                            diagnostics: [
                                ...(result.diagnostics ?? []),
                                { severity: "info" as const, message: outline },
                            ],
                        };
                    } finally {
                        await reader.close(context);
                    }
                },
            })),
        ],
    });
}

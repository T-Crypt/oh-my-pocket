/**
 * Lenient tool-call JSON: wraps Pi's coding tools so a call whose arguments a model wrote slightly wrong - an
 * object or an array sent as a JSON string, one edit block where the list of them belongs - is repaired before the
 * harness validates it, instead of failing validation and burning a turn on a retry of the same shape.
 */
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { repairToolArguments } from "../tool-repair.ts";
import type { PocketHost } from "../host.ts";

export default function createToolRepair(_host: PocketHost) {
    return defineExtension({
        name: "pocket-tool-repair",
        wraps: (CodingTools.tools ?? []).map((tool) =>
            wrapTool(tool, (each) => ({
                ...each,
                // The model's JSON in, its schema-checked arguments out: the harness still validates the repair.
                prepareArguments: (args: unknown) => repairToolArguments(args, each.parameters) as never,
            })),
        ),
    });
}

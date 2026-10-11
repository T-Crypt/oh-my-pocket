/**
 * Prune before summarising. When compaction selects the messages to summarise, this hook first offers a note that
 * costs no model call: most tool output masked to one line, the newest results kept in full, stale re-reads and
 * repeated calls dropped. Only when that note would still leave the context over its limit does the summary a
 * model writes run instead. PiP writes its own summaries and is left to them; off with `compaction.pruneToolOutput:
 * false` in Pi's settings.
 */
import { CompactionTask, defineExtension, hook } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

export default function createPruner(host: PocketHost) {
    return defineExtension({
        name: "pocket-pruner",
        hooks: [
            hook(CompactionTask, {
                beforeCompact: (compaction, api, context) =>
                    (host as Partial<PocketHost>).pruner === undefined
                        ? undefined
                        : host.pruner.summarize(compaction, api, context),
            }),
        ],
    });
}

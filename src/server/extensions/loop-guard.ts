/**
 * Loop guard: a tool call that is exactly identical to one that already failed this turn, or to one repeated a
 * third time, is blocked. A local model can fall into a loop of retrying a failing call, and a server that answers
 * one request at a time burns its whole slot on that; the fix is a different approach, which the no-repeat rule in
 * the system prompt also tells the model. A call a restart cut off is not a failure, and a fresh person's message
 * is a fresh chance to try the same thing.
 */
import { GenerationTask, ToolTask, defineExtension, hook } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

export default function createLoopGuard(host: PocketHost) {
    return defineExtension({
        name: "pocket-loop-guard",
        hooks: [
            hook(GenerationTask, {
                beforeRequest: (request, api) => {
                    (host as Partial<PocketHost>).loopGuard?.onRequest(request.messages, api.conversationId);
                },
            }),
            hook(ToolTask, {
                beforeTool: (call, api) => {
                    const guard = (host as Partial<PocketHost>).loopGuard;

                    if (guard === undefined) {
                        return undefined;
                    }

                    const why = guard.blocked(api.conversationId, call.name, call.arguments);

                    return why === undefined ? undefined : { block: why };
                },
                afterTool: (call, result, api) => {
                    const guard = (host as Partial<PocketHost>).loopGuard;

                    if (guard === undefined) {
                        return undefined;
                    }

                    guard.noteCall(api.conversationId, call.name, call.arguments, {
                        isError: result.isError === true,
                        interrupted: (result.diagnostics ?? []).some((each) => each.code === "interrupted"),
                    });
                },
            }),
        ],
    });
}

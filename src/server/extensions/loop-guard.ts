/**
 * Loop guard: the third exactly identical tool call in one turn is blocked, and the block says so when the earlier
 * runs failed; a file edit re-arms reads and shell checks. A local model can fall into a loop of retrying a failing call, and a server that answers
 * one request at a time burns its whole slot on that; the fix is a different approach, which the no-repeat rule in
 * the system prompt also tells the model. A call a restart cut off is not a failure, and a fresh person's message
 * is a fresh chance to try the same thing. Both hooks sign the arguments the harness prepared and validated -
 * `beforeTool` is given that form, `afterTool` is given the model's raw call, which the guard re-derives through
 * the same tool that ran it - so a call the wrapper repaired or validation coerced, a string limit or a JSON
 * string of an object, is blocked like the clean identical call.
 */
import type { Context } from "@earendil-works/chord";
import {
    GenerationTask,
    ToolTask,
    defineExtension,
    hook,
    type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { preparedArguments } from "../loop-guard.ts";

export default function createLoopGuard(host: PocketHost) {
    return defineExtension({
        name: "pocket-loop-guard",
        hooks: [
            hook(GenerationTask, {
                beforeRequest: (request, api) => {
                    (host as Partial<PocketHost>).loopGuard?.onRequest(
                        request.messages,
                        api.conversationId,
                    );
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
                afterTool: async (call, result, api, context) => {
                    const guard = (host as Partial<PocketHost>).loopGuard;

                    if (guard === undefined) {
                        return undefined;
                    }

                    // The hook is given the model's raw call, but `beforeTool` saw the arguments the harness
                    // prepared and validated: sign that same form, re-derived from the raw ones through the very
                    // tool the call ran under, or a call the wrapper repaired or validation coerced escapes the
                    // guard while its raw shape differs from the clean call's.
                    let tool: ToolRegistration | undefined;

                    try {
                        const resolve = (
                            api as {
                                agent?: (context: Context) => Promise<{
                                    tools: readonly ToolRegistration[];
                                }>;
                            }
                        ).agent;

                        tool =
                            resolve === undefined
                                ? undefined
                                : (await resolve(context)).tools.find(
                                      (each) => each.name === call.name,
                                  );
                    } catch {
                        tool = undefined;
                    }

                    guard.noteCall(api.conversationId, call.name, preparedArguments(call, tool), {
                        isError: result.isError === true,
                        interrupted: (result.diagnostics ?? []).some(
                            (each) => each.code === "interrupted",
                        ),
                    });
                },
            }),
        ],
    });
}

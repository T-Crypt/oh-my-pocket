/**
 * Routers: a session that runs as a router (`routers.ts`, chosen in the model picker's Routers group or the router
 * editor) gets the router's prompt, and a dispatcher router may not run commands or change files itself. Its stage
 * subagents run on the models the router names, through the subagent tool.
 */
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { promptOf } from "../routers.ts";

/** What a dispatcher router may not call: its stages do the work. */
const DISPATCHER_BLOCKED = new Set(["bash", "edit", "write"]);
/** A stage's instructions start so: a subagent is never the router, whatever its conversation holds. */
const SUBAGENT = 'You are the subagent "';

export default function createRouters(host: PocketHost) {
    return defineExtension({
        name: "pocket-routers",
        sections: [
            section(
                "router",
                async (input) => {
                    if ((input.agent.instructions ?? "").startsWith(SUBAGENT)) {
                        return undefined;
                    }

                    const router = await host.routerFor?.(input.conversationId);

                    return router === undefined ? undefined : promptOf(router);
                },
                { tag: false },
            ),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api) => {
                    if (!DISPATCHER_BLOCKED.has(call.name)) {
                        return undefined;
                    }

                    const router = await host.routerFor?.(api.conversationId);

                    return router?.dispatcher === true
                        ? {
                              block: `${router.label} is a dispatcher: bash, edit and write are blocked here. Put the work in a stage brief and spawn the stage.`,
                          }
                        : undefined;
                },
            }),
        ],
    });
}

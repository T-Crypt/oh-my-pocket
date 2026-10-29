/**
 * Quiet shell: the model's bash commands run without colors, pagers, or prompts. Escape codes in output cost tokens
 * and confuse a small model; a pager or a git credential prompt waits for a person who is not there. The same
 * variables DSH sets for its bash (and Codex hardcodes), plus git's prompt and editor switches. A command that sets
 * one itself still wins. Commands people run from the app's shell are not touched.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

/** What every command the model runs gets in its environment. */
export const QUIET_ENV: Readonly<Record<string, string>> = {
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
};

/** `env` with `QUIET_ENV` under every command it runs. */
export function quietEnv(env: ExecutionEnv): ExecutionEnv {
    return new Proxy(env, {
        get(target, key) {
            if (key === "exec") {
                return (
                    command: Parameters<ExecutionEnv["exec"]>[0],
                    options: Parameters<ExecutionEnv["exec"]>[1],
                    context: Parameters<ExecutionEnv["exec"]>[2],
                ) =>
                    target.exec(
                        command,
                        { ...options, env: { ...QUIET_ENV, ...options?.env } },
                        context,
                    );
            }

            const value = Reflect.get(target, key, target) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

export default function createQuietShell(_host: PocketHost) {
    const bash = (CodingTools.tools ?? []).find((tool) => tool.name === "bash") as
        ToolRegistration | undefined;

    if (bash === undefined) {
        return defineExtension({ name: "pocket-quiet-shell" });
    }

    return defineExtension({
        name: "pocket-quiet-shell",
        wraps: [
            wrapTool(bash, (tool) => ({
                ...tool,
                execute: (args, api, context) =>
                    tool.execute(
                        args,
                        api.env === undefined ? api : { ...api, env: quietEnv(api.env) },
                        context,
                    ),
            })),
        ],
    });
}

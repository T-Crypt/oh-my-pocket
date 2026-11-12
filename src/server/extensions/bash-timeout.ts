/**
 * Bash timeout: a command the model gave no timeout stops after five minutes (`PI_POCKET_BASH_TIMEOUT` seconds when set), and the model is told how to run long
 * work instead. Pi's bash has no default timeout, so a command that waits for input, a pager, a password prompt, or a
 * server that never exits holds the call (and, on a local server that answers one request at a time, the whole GPU)
 * until a person notices. A timeout the model passes is kept as it is. After DSH's bash, without its job registry: the
 * command is stopped, not moved to the background, and the model is told to start long work in the background itself.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

/** Seconds a command may run when the model did not say how long: `PI_POCKET_BASH_TIMEOUT`, or five minutes. */
export function defaultBashTimeout(): number {
    const set = Number(process.env.PI_POCKET_BASH_TIMEOUT);

    return Number.isFinite(set) && set > 0 ? set : 300;
}

const stopped = (seconds: number) =>
    `It had no timeout, so it was stopped after the default ${seconds} seconds. If it waited for input, run it with its non-interactive flag (--noconfirm, -y, ssh -o BatchMode=yes). If it is long work or a server, start it in the background with its output in a file (nohup CMD > /tmp/NAME.log 2>&1 &) and read the file, or pass a longer timeout.`;

export default function createBashTimeout(_host: PocketHost) {
    const bash = (CodingTools.tools ?? []).find((tool) => tool.name === "bash") as
        ToolRegistration | undefined;

    if (bash === undefined) {
        return defineExtension({ name: "pocket-bash-timeout" });
    }

    return defineExtension({
        name: "pocket-bash-timeout",
        wraps: [
            wrapTool(bash, (tool) => ({
                ...tool,
                description: `${tool.description} Without a timeout, a command stops after ${defaultBashTimeout()} seconds.`,
                execute: async (args, api, context) => {
                    const input = args as { command: string; timeout?: number };
                    const seconds = defaultBashTimeout();

                    if (input.timeout !== undefined) {
                        return tool.execute(args, api, context);
                    }

                    try {
                        return await tool.execute(
                            { ...input, timeout: seconds } as never,
                            api,
                            context,
                        );
                    } catch (error) {
                        if (error instanceof Error && /timed out/.test(error.message)) {
                            api.diagnostic({
                                severity: "info",
                                code: "default_timeout",
                                message: stopped(seconds),
                            });
                        }

                        throw error;
                    }
                },
            })),
        ],
    });
}

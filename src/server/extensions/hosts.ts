/**
 * SSH hosts: bash, read, write and edit take a `host` to work on another machine the owner set up in Menu → Hosts, over
 * one kept SSH connection, instead of Pi typing `ssh host '…'` into bash. With no hosts set up, the tools are as they
 * were. A host in `ask` mode waits for a person to allow each call, as Lancet Guard's questions do.
 */
import { str } from "@earendil-works/pi-schema";
import {
    defineExtension,
    hook,
    section,
    ToolTask,
    type ToolRegistration,
    wrapTool,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ApprovalAnswer, PocketHost } from "../host.ts";
import type { HostEntry } from "../hosts.ts";

/** ssh's options whose value can be the next word. */
const OPTIONS_WITH_VALUE = new Set(
    [
        "B",
        "b",
        "c",
        "D",
        "E",
        "e",
        "F",
        "I",
        "i",
        "J",
        "L",
        "l",
        "m",
        "O",
        "o",
        "p",
        "Q",
        "R",
        "S",
        "W",
        "w",
    ].map((letter) => `-${letter}`),
);

/** The tools that take a host. */
export const HOST_TOOLS = ["bash", "read", "write", "edit"] as const;

function oneLine(text: string, max = 200): string {
    const flat = text.trim().replace(/[\r\n]+/g, " ");

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a call to a host does, in one line for an approval card. */
function subjectOf(tool: string, args: Record<string, unknown>): string {
    if (tool === "bash") {
        return oneLine(String(args.command ?? ""));
    }

    return `${tool} ${String(args.path ?? "")}`;
}

/**
 * The host a bash command reaches by running ssh itself, as `ssh [options] host …` does, or undefined. Only a command
 * that starts with ssh counts: scp, rsync and ssh inside a script are left alone.
 */
export function sshedHost(command: string, hosts: readonly HostEntry[]): HostEntry | undefined {
    const words = command.trim().split(/\s+/);
    let at = 0;

    // `timeout 30 ssh …` and `env X=1 ssh …` still run ssh first.
    while (
        at < words.length &&
        /^(timeout|env|command|nice|nohup|exec|-?[0-9.]+[smh]?|[A-Za-z_]+=\S*)$/.test(words[at]!)
    ) {
        at++;
    }

    if (words[at] !== "ssh") {
        return undefined;
    }

    const rest = words.slice(at + 1);

    for (let index = 0; index < rest.length; index++) {
        const word = rest[index]!;

        if (word.startsWith("-")) {
            // ssh's options that take a value, given apart from it (`-o X=1`, `-p 22`): the value is not the host.
            if (OPTIONS_WITH_VALUE.has(word)) {
                index++;
            }

            continue;
        }

        const destination = word.replace(/^['"]|['"]$/g, "");
        const bare = destination.includes("@")
            ? destination.slice(destination.indexOf("@") + 1)
            : destination;

        return hosts.find(
            (host) =>
                host.name === destination ||
                host.name === bare ||
                host.target === destination ||
                host.target === bare ||
                host.target.endsWith(`@${bare}`),
        );
    }

    return undefined;
}

function guide(hosts: readonly HostEntry[]): string {
    const lines = hosts.map(
        (host) =>
            `- ${host.name}${host.note === undefined ? "" : `: ${host.note}`}${host.mode === "ask" ? " (each call waits for a person to allow it)" : ""}`,
    );

    return [
        "Other machines you can work on. To run a command or read, write or edit a file on one, pass its name as `host` to bash, read, write or edit; leave `host` out for this machine. Paths with `host` are paths on that machine; relative ones start in its working folder. Each call stands alone, as a fresh shell there.",
        "Do not run `ssh <host>` in bash yourself: `host` keeps one connection open, stops the command there on a timeout, and lets you read and edit its files directly.",
        ...lines,
    ].join("\n");
}

export default function createHosts(host: PocketHost) {
    const registry = host.hosts;
    const hosts = registry === undefined ? [] : registry.usable();

    if (registry === undefined || hosts.length === 0) {
        return defineExtension({ name: "pocket-hosts" });
    }

    const names = hosts.map((each) => each.name);
    const description = `Run on another machine instead of this one: ${names.map((name) => `"${name}"`).join(", ")}. Leave out for this machine.`;
    const tools = CodingTools.tools ?? [];

    const wraps = HOST_TOOLS.flatMap((name) => {
        const base = tools.find((tool) => tool.name === name) as ToolRegistration | undefined;

        if (base === undefined) {
            return [];
        }

        return [
            wrapTool(base, (tool) => {
                const parameters = tool.parameters as unknown as {
                    properties: Record<string, unknown>;
                    additionalProperties?: boolean;
                };

                return {
                    ...tool,
                    description: `${tool.description} Pass host to do it on another machine.`,
                    // pi-schema schemas are JSON Schema: the tool's own, with an optional `host` beside its properties.
                    parameters: {
                        ...parameters,
                        properties: { ...parameters.properties, host: str({ description }) },
                    } as unknown as typeof tool.parameters,
                    // The tools inside see their own arguments, repaired their own way; `host` goes around them.
                    prepareArguments: (args: unknown) => {
                        if (typeof args !== "object" || args === null || Array.isArray(args)) {
                            return (tool.prepareArguments?.(args) ?? args) as never;
                        }

                        const { host: target, ...rest } = args as Record<string, unknown>;
                        const inner = (tool.prepareArguments?.(rest) ?? rest) as Record<
                            string,
                            unknown
                        >;

                        return (
                            target === undefined || target === null || target === ""
                                ? inner
                                : { ...inner, host: target }
                        ) as never;
                    },
                    execute: async (args, api, context) => {
                        const { host: target, ...rest } = args as Record<string, unknown>;

                        if (typeof target !== "string" || target === "") {
                            return tool.execute(rest as never, api, context);
                        }

                        const env = await registry.envFor(target);

                        return tool.execute(rest as never, { ...api, env }, context);
                    },
                };
            }),
        ];
    });

    return defineExtension({
        name: "pocket-hosts",
        sections: [section("hosts", () => guide(hosts))],
        wraps,
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    if (!(HOST_TOOLS as readonly string[]).includes(call.name)) {
                        return undefined;
                    }

                    const args = (call.arguments ?? {}) as Record<string, unknown>;
                    const target = args.host;

                    if (target === undefined || target === "") {
                        if (call.name !== "bash") {
                            return undefined;
                        }

                        const reached = sshedHost(String(args.command ?? ""), registry.usable());

                        return reached === undefined
                            ? undefined
                            : {
                                  block: `Do not ssh to ${reached.name} yourself: call bash with host: "${reached.name}" and the command as it would run there. The connection is kept open for you.`,
                              };
                    }

                    const entry = registry.get(String(target));

                    if (entry === undefined || entry.mode === "off") {
                        const usable = registry.usable().map((each) => each.name);

                        return {
                            block: `There is no host named ${String(target)}.${usable.length === 0 ? "" : ` Hosts: ${usable.join(", ")}.`}`,
                        };
                    }

                    if (entry.mode !== "ask") {
                        return undefined;
                    }

                    const subject = subjectOf(call.name, args);
                    let answer = await api.memo<ApprovalAnswer>("pocket.host-approval", context);

                    if (answer === undefined) {
                        const asked = await host.approvals.request(
                            {
                                id: `${api.taskId}:${call.id}`,
                                conversationId: api.conversationId,
                                taskId: api.taskId,
                                callId: call.id,
                                tool: `${call.name} on ${entry.name}`,
                                subject,
                                reason: `${entry.name} asks before each call`,
                                createdAt: Date.now(),
                            },
                            context,
                        );

                        answer = await api.memo<ApprovalAnswer>(
                            "pocket.host-approval",
                            asked,
                            context,
                        );
                    }

                    return answer.allow
                        ? undefined
                        : {
                              block: `${answer.by} denied this ${call.name} call on ${entry.name}. Call: ${subject}`,
                          };
                },
            }),
        ],
    });
}

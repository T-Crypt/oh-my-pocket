/**
 * Lean prompt: tools Pi seldom needs are offered on request, so every request carries a smaller prompt; Pi loads one
 * with load_tools when the work calls for it.
 *
 * Measured on six days of real use (27,163 tool calls): bash, read, edit, and write made 96.5% of the calls, while the
 * tools listed here made 0.4% and cost about 9,700 of the 15,900 tokens a request carried before anyone typed. A local
 * model reads all of that again on every cold start. Deferred, a tool and the section that teaches it are left out of
 * the prompt until loaded; a one-line list of what can be loaded takes their place.
 *
 * The browser is deferred too, but it is the session's switch (`extensions/browser.ts`): load_tools never loads it.
 */
import { Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    type PromptSection,
    section,
    type ToolRegistration,
    type Wrap,
} from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";

/** The tools offered on request unless the owner says otherwise, each with the sections that only it needs. */
const SECTIONS_OF: Readonly<Record<string, readonly string[]>> = {
    artifact: ["artifacts"],
    artifact_inline: ["artifacts"],
    design_export: ["design_mode"],
    design_system: ["design_mode"],
    design_preview: ["design_mode"],
    codemode: ["codemode"],
    background: ["background_tasks"],
    schedule: ["schedules"],
    watch_pr: [],
};

/** Never loaded here: a person turns it on for the session. */
const NOT_LOADABLE = new Set(["browser"]);

/** A tool's description cut to its first sentence, as a line of the list. */
function firstSentence(text: string, max = 80): string {
    const flat = text.replace(/\s+/g, " ").trim();
    const end = flat.search(/[.:;](\s|$)/);
    const first = end === -1 ? flat : flat.slice(0, end);

    return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export default function createLeanPrompt(host: PocketHost, web: ExtensionWeb) {
    // Loading changes what Pi is offered, nothing else: plan mode lets it through.
    host.readOnlyCalls.set("load_tools", () => true);

    web.settings([
        {
            name: "onRequest",
            label: "Tools offered on request",
            description:
                "Comma-separated tool names. Pi sees each in a one-line list and loads it with load_tools when it needs it; until then neither its schema nor its guide is in the prompt.",
            type: "text",
            default: Object.keys(SECTIONS_OF).join(", "),
        },
    ]);

    // The list shapes the module itself (its wraps): a change loads it again.
    web.onSettings(() => void host.reloadModule("lean-prompt.ts"));

    const setting = web.setting("onRequest");
    // PI_POCKET_LEAN_PROMPT=0 offers every tool, as before this module (the test suite runs that way).
    const deferred = (
        process.env.PI_POCKET_LEAN_PROMPT === "0" || typeof setting !== "string" ? "" : setting
    )
        .split(/[\s,]+/)
        .map((name) => name.trim())
        .filter((name) => name !== "" && !NOT_LOADABLE.has(name));
    // A section shows while any of the tools that need it is offered.
    const owners = new Map<string, string[]>();

    for (const tool of deferred) {
        for (const key of SECTIONS_OF[tool] ?? []) {
            owners.set(key, [...(owners.get(key) ?? []), tool]);
        }
    }

    const wraps: Wrap[] = [
        ...deferred.map((name): Wrap => ({
            tool: name,
            wrap: (tool: ToolRegistration) => ({ ...tool, deferred: true as const }),
        })),
        ...[...owners].map(([key, tools]): Wrap => ({
            section: key,
            wrap: (inner: PromptSection) => ({
                ...inner,
                render: (...args: Parameters<PromptSection["render"]>) =>
                    args[0].agent.tools.some((tool) => tools.includes(tool.name))
                        ? inner.render(...args)
                        : undefined,
            }),
        })),
    ];

    const loader = defineTool({
        name: "load_tools",
        description:
            "Load tools that are offered on request (listed under more_tools in your instructions); they are yours from your next step on.",
        parameters: Type.Object({
            names: Type.Array(Type.String(), {
                description: "Tool names from the more_tools list.",
                minItems: 1,
            }),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            const agent = await api.agent(context);
            const loadable = new Set(
                agent.deferred.map((tool) => tool.name).filter((name) => !NOT_LOADABLE.has(name)),
            );
            const offered = new Set(agent.tools.map((tool) => tool.name));
            const names = [...new Set(args.names.map((name) => name.trim()))];
            const loading = names.filter((name) => loadable.has(name));
            const already = names.filter((name) => offered.has(name));
            const unknown = names.filter((name) => !loadable.has(name) && !offered.has(name));
            const lines = [
                ...(loading.length === 0
                    ? []
                    : [`Loaded ${loading.join(", ")}: yours from your next step.`]),
                ...(already.length === 0 ? [] : [`Already yours: ${already.join(", ")}.`]),
                ...(unknown.length === 0
                    ? []
                    : [
                          `Not on the list: ${unknown.join(", ")}.${names.includes("browser") ? " The browser is a person's switch, by the message box: ask them." : ""}`,
                      ]),
            ];

            return {
                output: [{ type: "text", text: lines.join("\n") }],
                ...(loading.length === 0
                    ? { isError: unknown.length > 0 }
                    : { control: { addTools: loading } }),
            };
        },
    });

    return defineExtension({
        name: "pocket-lean-prompt",
        tools: [loader],
        wraps,
        sections: [
            section("more_tools", ({ agent }) => {
                const list = agent.deferred.filter((tool) => !NOT_LOADABLE.has(tool.name));

                return list.length === 0
                    ? undefined
                    : `More tools are offered on request; load one with load_tools when the work needs it:\n${list
                          .map((tool) => `- ${tool.name}: ${firstSentence(tool.description ?? "")}`)
                          .join("\n")}`;
            }),
        ],
    });
}

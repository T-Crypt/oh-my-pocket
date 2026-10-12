/**
 * Agent definitions: named roles a subagent can start as. Each is a Markdown file in the data folder's `agents/`
 * (`~/.pi-pocket/agents/<name>.md`): a front matter of simple `key: value` lines, then the role's instructions.
 *
 *     ---
 *     description: Reviews a diff and reports findings. Never edits.
 *     model: llama-swap/review
 *     thinking: high
 *     tools: read, bash
 *     ---
 *     You are the reviewer. ...
 *
 * Every key is optional. `tools` is a comma-separated list, with or without brackets. The subagent tool's own
 * arguments win over the definition's.
 *
 * Pi Pocket ships a few of its own (`defaults/agents/`: the built-in pipeline router's stages), needing no skills or
 * models of anyone's; a file of the same name in the data folder takes a built-in one's place.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentDefinition = {
    name: string;
    description?: string;
    model?: string;
    thinking?: string;
    tools?: string[];
    instructions: string;
    /** One Pi Pocket ships, not one in the data folder. */
    builtIn?: true;
};

/** Pi Pocket's own definitions. */
export const BUILT_IN_AGENTS = join(dirname(fileURLToPath(import.meta.url)), "defaults", "agents");

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export function agentsDir(dataDir: string): string {
    return join(dataDir, "agents");
}

function parse(name: string, text: string): AgentDefinition {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const fields: Record<string, string> = {};

    if (match !== null) {
        for (const line of match[1]!.split(/\r?\n/)) {
            const colon = line.indexOf(":");

            if (colon > 0) {
                fields[line.slice(0, colon).trim()] = line
                    .slice(colon + 1)
                    .trim()
                    .replace(/^["']|["']$/g, "");
            }
        }
    }

    const tools = fields.tools
        ?.replace(/^\[|\]$/g, "")
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool !== "");

    return {
        name,
        ...(fields.description ? { description: fields.description } : {}),
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.thinking ? { thinking: fields.thinking } : {}),
        ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
        instructions: (match === null ? text : text.slice(match[0].length)).trim(),
    };
}

/** The definitions in one folder, by name. A missing folder has none. */
function inFolder(dir: string): AgentDefinition[] {
    let files: string[];

    try {
        files = readdirSync(dir);
    } catch {
        return [];
    }

    return files
        .filter((file) => file.endsWith(".md") && NAME.test(file.slice(0, -3)))
        .sort()
        .map((file) => parse(file.slice(0, -3), readFileSync(join(dir, file), "utf8")));
}

/** Every definition, by name: the data folder's, then Pi Pocket's own that none of those replaces. */
export function listAgents(dataDir: string): AgentDefinition[] {
    const own = inFolder(agentsDir(dataDir));
    const names = new Set(own.map((agent) => agent.name));

    return [
        ...own,
        ...inFolder(BUILT_IN_AGENTS)
            .filter((agent) => !names.has(agent.name))
            .map((agent) => ({ ...agent, builtIn: true as const })),
    ];
}

/** One definition, read fresh so an edit applies to the next spawn; an error names the ones there are. */
export function loadAgent(dataDir: string, name: string): AgentDefinition {
    if (NAME.test(name)) {
        for (const dir of [agentsDir(dataDir), BUILT_IN_AGENTS]) {
            try {
                const agent = parse(name, readFileSync(join(dir, `${name}.md`), "utf8"));

                return dir === BUILT_IN_AGENTS ? { ...agent, builtIn: true } : agent;
            } catch {
                // The next folder, then the error below.
            }
        }
    }

    const names = listAgents(dataDir).map((agent) => agent.name);

    throw new Error(
        `No agent definition named ${name}. Available: ${names.length === 0 ? "none" : names.join(", ")}`,
    );
}

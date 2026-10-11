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
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AgentDefinition = {
    name: string;
    description?: string;
    model?: string;
    thinking?: string;
    tools?: string[];
    instructions: string;
};

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

/** Every definition in the folder, by name. A missing folder has none. */
export function listAgents(dataDir: string): AgentDefinition[] {
    let files: string[];

    try {
        files = readdirSync(agentsDir(dataDir));
    } catch {
        return [];
    }

    return files
        .filter((file) => file.endsWith(".md") && NAME.test(file.slice(0, -3)))
        .sort()
        .map((file) =>
            parse(file.slice(0, -3), readFileSync(join(agentsDir(dataDir), file), "utf8")),
        );
}

/** One definition, read fresh so an edit applies to the next spawn; an error names the ones there are. */
export function loadAgent(dataDir: string, name: string): AgentDefinition {
    if (NAME.test(name)) {
        try {
            return parse(name, readFileSync(join(agentsDir(dataDir), `${name}.md`), "utf8"));
        } catch {
            // Falls through to the error below.
        }
    }

    const names = listAgents(dataDir).map((agent) => agent.name);

    throw new Error(
        `No agent definition named ${name}. Available: ${names.length === 0 ? "none" : names.join(", ")}`,
    );
}

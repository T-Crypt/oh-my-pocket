/**
 * Routers: a session that plans, implements, and reviews through stage subagents, each stage on a model of its own.
 * A router is a model the session runs on, the prompt that makes it a router, and which model each stage role (an
 * agent definition, `~/.pi-pocket/agents/<role>.md`) runs on. Its stages keep their roles' instructions and tools;
 * only the model comes from the router.
 *
 * Two kinds, one list:
 * - detected: router prompts already on this machine: `~/.pi-pocket/routers/*.md`, Oh My Pi's
 *   `~/.omp/agent/router/ROUTER*.md`, and Pi Pocket's built-in pipeline (`defaults/routers/`). Their stages are the agent definitions the prompt names in
 *   backticks, each on its definition's model, and their model is the model whose id is the router's
 *   (`router-fast`, ...). The prompt is read from its file at every request, so a harness that renders it again
 *   changes it in place.
 * - custom: saved from the router editor to `~/.pi-pocket/routers/<id>.json`. One saved with a detected router's id
 *   takes its place; deleting it brings the detected one back.
 *
 * A session uses one through `RouterDoc`: its people pick it in the model picker's Routers group or in the editor.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type AgentDefinition, listAgents } from "./agents.ts";

export type RouterConfig = {
    /** Short and stable: lowercase letters, digits, and dashes. */
    id: string;
    label: string;
    /** `provider/modelId`: the model the router session itself runs on. */
    model: string;
    thinking?: string;
    /** The router prompt's text; for a detected router, read from `promptFile` instead. */
    prompt?: string;
    promptFile?: string;
    /** Stage role (agent definition name) to `provider/modelId`. A role left out runs as its definition says. */
    stages: Record<string, string>;
    /** Stage role to its thinking level; a role left out thinks as its definition says. */
    stageThinking?: Record<string, string>;
    /** Dispatcher only: the router itself may not run commands or change files; its stages do the work. */
    dispatcher?: boolean;
    source: "custom" | "detected";
    /** Where a detected router was found, in words: "Pi Pocket", "Oh My Pi". */
    from?: string;
    /** A custom router saved over a detected one with its id. */
    overrides?: boolean;
};

export const ROUTER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_PROMPT = 200_000;

/** The places detected routers come from, Pi Pocket's own first: the first of an id wins. */
export function promptPlaces(dataDir: string, home = homedir()) {
    return [
        { dir: routersDir(dataDir), from: "Pi Pocket" },
        { dir: join(home, ".omp", "agent", "router"), from: "Oh My Pi" },
        { dir: BUILT_IN_ROUTERS, from: "built in" },
    ];
}

/** Pi Pocket's own router prompts. */
const BUILT_IN_ROUTERS = join(dirname(fileURLToPath(import.meta.url)), "defaults", "routers");

/** `ROUTER.md` is `router`, `ROUTER-FAST.md` is `router-fast`, and `pipeline.md` is `pipeline`. */
function idOfFile(file: string): string | undefined {
    const match = /^ROUTER(?:-([A-Za-z0-9-]+))?\.md$/.exec(file);

    if (match !== null) {
        return match[1] === undefined ? "router" : `router-${match[1].toLowerCase()}`;
    }

    const id = file.endsWith(".md") ? file.slice(0, -3).toLowerCase() : "";

    return ROUTER_ID.test(id) ? id : undefined;
}

/** A main `ROUTER.md` before the rest, so it is the one a new router starts from. */
const mainFirst = (a: string, b: string) =>
    Number(b === "ROUTER.md") - Number(a === "ROUTER.md") || a.localeCompare(b);

/** Whether `file` is a router prompt in one of `places`: the only files a router's prompt may be read from. */
export function isRouterPrompt(file: string, places: readonly { dir: string }[]): boolean {
    const full = resolvePath(file);

    return (
        full.endsWith(".md") &&
        places.some((place) => dirname(full) === resolvePath(place.dir)) &&
        existsSync(full)
    );
}

/** The agent definitions a prompt names in backticks, in the order it names them first. */
export function namedStages(prompt: string, definitions: readonly AgentDefinition[]): string[] {
    const names = new Set(definitions.map((definition) => definition.name));
    const found: string[] = [];

    for (const match of prompt.matchAll(/`([a-z0-9][a-z0-9_-]*)`/gi)) {
        const name = match[1]!;

        if (names.has(name) && !found.includes(name)) {
            found.push(name);
        }
    }

    return found;
}

/**
 * Routers on this machine, from their prompts. `modelFor` finds the model a router id names (`router-fast` on
 * whichever provider serves it); a prompt with no such model is still listed, on `fallbackModel` if given.
 */
export function detectRouters(
    places: readonly { dir: string; from: string }[],
    definitions: readonly AgentDefinition[],
    modelFor: (id: string) => ModelRef | undefined,
): RouterConfig[] {
    const routers = new Map<string, RouterConfig>();

    for (const { dir, from } of places) {
        let files: string[];

        try {
            files = readdirSync(dir).sort(mainFirst);
        } catch {
            continue;
        }

        for (const file of files) {
            const id = idOfFile(file);

            if (id === undefined || routers.has(id)) {
                continue;
            }

            const promptFile = join(dir, file);
            let prompt: string;

            try {
                prompt = readFileSync(promptFile, "utf8");
            } catch {
                continue;
            }

            const ref = modelFor(id);
            const stages: Record<string, string> = {};

            for (const name of namedStages(prompt, definitions)) {
                const model = definitions.find((each) => each.name === name)?.model;

                if (model !== undefined) {
                    stages[name] = model;
                }
            }

            routers.set(id, {
                id,
                label: id,
                model: ref === undefined ? "" : `${ref.provider}/${ref.modelId}`,
                promptFile,
                stages,
                source: "detected",
                from,
            });
        }
    }

    return [...routers.values()];
}

export function routersDir(dataDir: string): string {
    return join(dataDir, "routers");
}

/** Saved routers; a file that cannot be read or parsed is left out, not fatal. */
export function savedRouters(dataDir: string): RouterConfig[] {
    let files: string[];

    try {
        files = readdirSync(routersDir(dataDir)).sort();
    } catch {
        return [];
    }

    return files.flatMap((file) => {
        if (!file.endsWith(".json") || !ROUTER_ID.test(file.slice(0, -5))) {
            return [];
        }

        try {
            const router = JSON.parse(
                readFileSync(join(routersDir(dataDir), file), "utf8"),
            ) as RouterConfig;

            return router.id === file.slice(0, -5)
                ? [{ ...router, source: "custom" as const }]
                : [];
        } catch {
            return [];
        }
    });
}

/** Every router: detected ones, each replaced by a saved one with its id, then the other saved ones. */
export function allRouters(
    dataDir: string,
    modelFor: (id: string) => ModelRef | undefined,
    home = homedir(),
): RouterConfig[] {
    const definitions = listAgents(dataDir);
    const detected = detectRouters(promptPlaces(dataDir, home), definitions, modelFor);
    const saved = savedRouters(dataDir);
    const ids = new Set(detected.map((router) => router.id));

    return [
        ...detected.map((router) => {
            const over = saved.find((each) => each.id === router.id);

            return over === undefined ? router : { ...over, overrides: true };
        }),
        ...saved.filter((router) => !ids.has(router.id)),
    ];
}

/** A router's prompt as it is now: its own text, or its file read again. */
export function promptOf(router: RouterConfig): string | undefined {
    if (router.prompt !== undefined) {
        return router.prompt;
    }

    if (router.promptFile !== undefined) {
        try {
            return readFileSync(router.promptFile, "utf8");
        } catch {
            return undefined;
        }
    }

    return undefined;
}

/**
 * A router from the editor, checked: an id, a label, a model, and stages that are `provider/modelId`. `resolve`
 * throws for a model Pi cannot use now, which refuses the router's own model; a stage on a model not signed in is
 * kept, as a sign-in can come later, and is refused when that stage starts.
 */
export function checkRouter(
    input: unknown,
    resolve: (spec: string) => ModelRef,
    thinkingLevels: readonly string[],
    places: readonly { dir: string }[] = [],
): RouterConfig {
    const fail = (message: string): never => {
        throw new Error(message);
    };

    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<
        string,
        unknown
    >;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";

    if (!ROUTER_ID.test(id)) {
        fail("id must be lowercase letters, digits, and dashes, starting with a letter or digit");
    }

    const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label.trim() : id;

    if (typeof raw.model !== "string" || raw.model.trim() === "") {
        fail("model must be provider/modelId");
    }

    const ref = resolve(raw.model as string);
    const thinking = raw.thinking;

    if (
        thinking !== undefined &&
        (typeof thinking !== "string" || !thinkingLevels.includes(thinking))
    ) {
        fail(`thinking must be one of ${thinkingLevels.join(", ")}`);
    }

    const prompt = raw.prompt;
    const promptFile = raw.promptFile;

    if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > MAX_PROMPT)) {
        fail("prompt must be text");
    }

    if (
        promptFile !== undefined &&
        (typeof promptFile !== "string" || !isRouterPrompt(promptFile, places))
    ) {
        fail("promptFile must be one of the detected router prompts");
    }

    if (prompt === undefined && promptFile === undefined) {
        fail("a router needs a prompt: its own text, or a detected router's prompt file");
    }

    const stages: Record<string, string> = {};

    if (typeof raw.stages !== "object" || raw.stages === null || Array.isArray(raw.stages)) {
        fail("stages must map role names to provider/modelId");
    }

    for (const [role, spec] of Object.entries(raw.stages as Record<string, unknown>)) {
        if (
            !/^[a-z0-9][a-z0-9_-]*$/i.test(role) ||
            typeof spec !== "string" ||
            !spec.includes("/")
        ) {
            fail(`stage ${role} must name a model as provider/modelId`);
        }

        stages[role] = (spec as string).trim();
    }

    const stageThinking: Record<string, string> = {};

    if (raw.stageThinking !== undefined) {
        if (
            typeof raw.stageThinking !== "object" ||
            raw.stageThinking === null ||
            Array.isArray(raw.stageThinking)
        ) {
            fail("stageThinking must map role names to thinking levels");
        }

        for (const [role, level] of Object.entries(raw.stageThinking as Record<string, unknown>)) {
            if (typeof level !== "string" || !thinkingLevels.includes(level)) {
                fail(`stage ${role}'s thinking must be one of ${thinkingLevels.join(", ")}`);
            }

            stageThinking[role] = level as string;
        }
    }

    return {
        id,
        label,
        model: `${ref.provider}/${ref.modelId}`,
        ...(thinking === undefined ? {} : { thinking: thinking as string }),
        ...(prompt === undefined
            ? { promptFile: promptFile as string }
            : { prompt: prompt as string }),
        stages,
        ...(Object.keys(stageThinking).length === 0 ? {} : { stageThinking }),
        ...(raw.dispatcher === true ? { dispatcher: true } : {}),
        source: "custom",
    };
}

export function saveRouter(dataDir: string, router: RouterConfig): void {
    mkdirSync(routersDir(dataDir), { recursive: true });
    const { source: _source, overrides: _overrides, from: _from, ...kept } = router;

    writeFileSync(
        join(routersDir(dataDir), `${router.id}.json`),
        `${JSON.stringify(kept, null, 4)}\n`,
    );
}

/** Delete a saved router; true when there was one. A detected one with its id shows again. */
export function deleteRouter(dataDir: string, id: string): boolean {
    const file = join(routersDir(dataDir), `${id}.json`);

    if (!ROUTER_ID.test(id) || !existsSync(file)) {
        return false;
    }

    rmSync(file);

    return true;
}

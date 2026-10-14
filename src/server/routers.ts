/**
 * Routers: a session that takes each task through a pipeline of stage subagents, each stage on a model of its own.
 *
 * A router made in the router editor is a list of stages, in order. The router itself (the session's model) does the
 * fit check: it answers a question directly, or picks which of its stages a task needs, and never adds one. Each
 * stage is a template (plan, implement, review, fix, ship, or custom) whose instructions its person may edit, the
 * skills it reads before it starts (any installed skill), a model, and a thinking level; or one of its person's own
 * agent definitions (`~/.pi-pocket/agents/<role>.md`). The router's prompt is written from its stages
 * (`pipelinePrompt`), so nobody edits a prompt by hand.
 *
 * Pi Pocket ships one, `standard`: plan, implement, review, fix, ship. Saved routers live in
 * `~/.pi-pocket/routers/<id>.json`; one saved as `standard` takes the built-in one's place.
 *
 * Routers detected on this machine are read-only: router prompts in `~/.pi-pocket/routers/*.md` and Oh My Pi's
 * `~/.omp/agent/router/ROUTER*.md`, their stages the agent definitions the prompt names in backticks. Their prompt is
 * read from its file at every request. They show only where they exist.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type AgentDefinition, listAgents } from "./agents.ts";

export const TEMPLATES = ["plan", "implement", "review", "fix", "ship", "custom"] as const;
export type Template = (typeof TEMPLATES)[number];

export type PipelineStage = {
    /** Short and stable, unique in the router: what the router spawns it by (`agent: <id>`). */
    id: string;
    name: string;
    template: Template;
    /** What the stage does: the template's words, as its person left or changed them. */
    instructions: string;
    /** Skills the stage reads in full before it starts, by name: any its person has installed. */
    skills?: string[];
    /** `provider/modelId`; none runs it on the router's own model. */
    model?: string;
    thinking?: string;
    /** One of its person's own agent definitions, run in place of the template and instructions above. */
    role?: string;
};

export type RouterConfig = {
    /** Short and stable: lowercase letters, digits, and dashes. */
    id: string;
    label: string;
    /** `provider/modelId`: the model the router session itself runs on; empty keeps the session's. */
    model: string;
    thinking?: string;
    /** The stages, in order: a router from the editor. */
    pipeline?: PipelineStage[];
    /** Anything else the router should be told, after what its stages say. */
    extra?: string;
    /** A detected router's prompt file, read at every request. */
    promptFile?: string;
    /** A detected router's stages: agent definition to `provider/modelId`. */
    stages: Record<string, string>;
    /** Dispatcher only: the router itself may not run commands or change files; its stages do the work. */
    dispatcher?: boolean;
    source: "custom" | "detected" | "built in";
    /** Where a detected router was found, in words: "Pi Pocket", "Oh My Pi". */
    from?: string;
    /** A saved router with the id of a built-in or detected one, which it replaces. */
    overrides?: boolean;
};

export const ROUTER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const STAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TEXT = 20_000;
const MAX_STAGES = 12;
const MAX_SKILLS = 12;

/** Each template's tools and its words, as a new stage starts with them. */
export const TEMPLATE_INFO: Record<
    Template,
    { name: string; tools: string[]; instructions: string }
> = {
    plan: {
        name: "Plan",
        tools: ["read", "bash", "write"],
        instructions:
            "Read the repository's own instruction files and the code the task touches. Write plan.md in the run folder: the goal in one sentence, the files to change and how, the steps in order each with the command that proves it, and the risks. Change no other file. If the task is unclear, say so in plan.md instead of guessing.",
    },
    implement: {
        name: "Implement",
        tools: ["read", "bash", "edit", "write"],
        instructions:
            "Carry out plan.md step by step. After each step, run its check and read the output. A step that is wrong or impossible: stop and say which and why. Keep the change to what the plan asks, and run the project's tests at the end.",
    },
    review: {
        name: "Review",
        tools: ["read", "bash", "write"],
        instructions:
            "Review the change (git diff) against plan.md: run the tests, try the inputs most likely to break it, and read the code that calls what changed. Write review.md in the run folder: each finding with file, line, the input that breaks it, and what goes wrong; or say plainly that it is clean. Edit no other file.",
    },
    fix: {
        name: "Fix",
        tools: ["read", "bash", "edit", "write"],
        instructions:
            "Fix each finding in review.md, and only those. Run the tests again, and say for each finding what you changed and what proves it fixed.",
    },
    ship: {
        name: "Ship",
        tools: ["read", "bash"],
        instructions:
            "Commit the change on a new branch (never the default branch), push it, and open a draft pull request that says what changed and what the stages proved. Never merge. Answer with the branch and the pull request's link.",
    },
    custom: {
        name: "Custom",
        tools: ["read", "bash", "edit", "write"],
        instructions: "Describe what this stage does.",
    },
};

/** Pi Pocket's own router: the full pipeline, every stage on the router's model until its person changes it. */
export const STANDARD: RouterConfig = {
    id: "standard",
    label: "Standard",
    model: "",
    pipeline: (["plan", "implement", "review", "fix", "ship"] as const).map((template) => ({
        id: template,
        name: TEMPLATE_INFO[template].name,
        template,
        instructions: TEMPLATE_INFO[template].instructions,
    })),
    stages: {},
    source: "built in",
};

/** The prompt a router from the editor runs with: written from its stages, then its extra words. */
export function pipelinePrompt(router: RouterConfig): string {
    const stages = router.pipeline ?? [];
    const has = (template: Template) => stages.some((stage) => stage.template === template);
    const lines = [
        `## You are a router: ${router.label}`,
        "",
        "Each task the person gives you goes through these stages, in this order. Each stage is a fresh subagent: start it with the `subagent` tool (`action: spawn`, `agent:` the stage's id below, a new `name` each time, the brief as `message`, `wait: true`); its answer comes back as the call's result.",
        "",
        ...stages.map(
            (stage, index) =>
                `${index + 1}. ${stage.name} (agent: \`${stage.id}\`): ${stage.instructions.split("\n")[0]}`,
        ),
        "",
        "First, the fit check, which is yours alone:",
        "- A question, or something you can answer in a few lines: answer it yourself, with no stages.",
        "- A task: pick the stages it needs, in the order above. A small one may skip some (a one-line fix needs no plan); never add a stage that is not listed.",
        "- Unclear what the person wants: ask before starting.",
        "",
        "How stages work:",
        "- Pick a run folder for the task (`.router/<date>-<slug>/` in the repository). Stages share files there, not this conversation: everything a stage needs goes in its brief or in the run folder.",
        ...(has("fix")
            ? [
                  "- Run the fix stage only when the review stage reported findings, then review once more.",
              ]
            : []),
        ...(has("ship")
            ? ["- Run the ship stage last, and only when the stages before it ended clean."]
            : ["- Commit, push, or publish nothing unless the person asked."]),
        "- At the end, tell the person what changed, what the stages proved, and what is still open.",
    ];

    return router.extra?.trim()
        ? `${lines.join("\n")}\n\n${router.extra.trim()}\n`
        : `${lines.join("\n")}\n`;
}

/**
 * A pipeline stage as the subagent tool starts it: its instructions, the skills it reads first (each skill's file, as
 * `skillFile` finds it; one no longer installed is named, so the stage says so), and its template's tools.
 */
export function stageDefinition(
    stage: PipelineStage,
    skillFile: (name: string) => string | undefined,
): AgentDefinition {
    const skills = (stage.skills ?? []).map((name) => {
        const file = skillFile(name);

        return file === undefined
            ? `- ${name}: not installed here; say so in your answer`
            : `- ${name}: ${file}`;
    });

    return {
        name: stage.id,
        instructions: [
            `You are the ${stage.name} stage of a router's pipeline. The brief names the task and a run folder.`,
            ...(skills.length === 0
                ? []
                : [
                      "",
                      "Before anything else, read each of these skills in full and follow them in this stage:",
                      ...skills,
                  ]),
            "",
            stage.instructions,
        ].join("\n"),
        tools: TEMPLATE_INFO[stage.template].tools,
    };
}

/** What a stage of a router runs on, by the name the router spawns it as: a pipeline stage, or a detected stage. */
export function stageOf(
    router: RouterConfig | undefined,
    name: string,
): { model?: string; thinking?: string; stage?: PipelineStage } | undefined {
    const stage = router?.pipeline?.find((each) => each.id === name);

    if (stage !== undefined) {
        const model = stage.model || router!.model;

        return {
            ...(model ? { model } : {}),
            ...(stage.thinking ? { thinking: stage.thinking } : {}),
            stage,
        };
    }

    const model = router?.stages[name];

    return model === undefined ? undefined : { model };
}

/** Every model a router's stages run on: allowed to them, as choosing the router chose them. */
export function stageModels(router: RouterConfig | undefined): string[] {
    if (router === undefined) {
        return [];
    }

    const models = [
        ...Object.values(router.stages),
        ...(router.pipeline ?? []).map((stage) => stage.model || router.model),
    ];

    return [...new Set(models.filter((model) => model.includes("/")))];
}

/** The places detected routers come from, this data folder's first: the first of an id wins. */
export function promptPlaces(dataDir: string, home = homedir()) {
    return [
        { dir: routersDir(dataDir), from: "Pi Pocket" },
        { dir: join(home, ".omp", "agent", "router"), from: "Oh My Pi" },
    ];
}

/** `ROUTER.md` is `router`, `ROUTER-FAST.md` is `router-fast`, and `other.md` is `other`. */
function idOfFile(file: string): string | undefined {
    const match = /^ROUTER(?:-([A-Za-z0-9-]+))?\.md$/.exec(file);

    if (match !== null) {
        return match[1] === undefined ? "router" : `router-${match[1].toLowerCase()}`;
    }

    const id = file.endsWith(".md") ? file.slice(0, -3).toLowerCase() : "";

    return ROUTER_ID.test(id) ? id : undefined;
}

/** A main `ROUTER.md` before the rest. */
const mainFirst = (a: string, b: string) =>
    Number(b === "ROUTER.md") - Number(a === "ROUTER.md") || a.localeCompare(b);

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

/** Routers detected from their prompts. `modelFor` finds the model whose id is the router's. */
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

            // Only routers from the editor: a saved one has stages to run, and no prompt file of its own.
            return router.id === file.slice(0, -5) && Array.isArray(router.pipeline)
                ? [{ ...router, promptFile: undefined, stages: {}, source: "custom" as const }]
                : [];
        } catch {
            return [];
        }
    });
}

/** Every router: the saved ones, then the built-in one and the detected ones that none of those replaces. */
export function allRouters(
    dataDir: string,
    modelFor: (id: string) => ModelRef | undefined,
    home = homedir(),
): RouterConfig[] {
    const detected = detectRouters(promptPlaces(dataDir, home), listAgents(dataDir), modelFor);
    const saved = savedRouters(dataDir);
    const shipped = [STANDARD, ...detected];
    const ids = new Set(saved.map((router) => router.id));

    return [
        ...saved.map((router) =>
            shipped.some((each) => each.id === router.id) ? { ...router, overrides: true } : router,
        ),
        ...shipped.filter((router) => !ids.has(router.id)),
    ];
}

/** A router's prompt as it is now: written from its stages, or its file read again. */
export function promptOf(router: RouterConfig): string | undefined {
    if (router.pipeline !== undefined) {
        return pipelinePrompt(router);
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
 * A router from the editor, checked: an id, a label, and its stages. `resolve` throws for a model Pi cannot use now,
 * which refuses the router's own model; a stage's model is only checked for its form, as a sign-in can come later.
 * `roles` and `skills` are the agent definitions and skills a stage may name.
 */
export function checkRouter(
    input: unknown,
    resolve: (spec: string) => ModelRef,
    thinkingLevels: readonly string[],
    roles: readonly string[] = [],
    skills: readonly string[] = [],
): RouterConfig {
    const fail = (message: string): never => {
        throw new Error(message);
    };

    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<
        string,
        unknown
    >;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";

    const level = (value: unknown, what: string) => {
        if (value === undefined || value === "") {
            return undefined;
        }

        return typeof value === "string" && thinkingLevels.includes(value)
            ? value
            : fail(`${what} must be one of ${thinkingLevels.join(", ")}`);
    };

    const text = (value: unknown, what: string) =>
        value === undefined || (typeof value === "string" && value.length <= MAX_TEXT)
            ? (value as string | undefined)
            : fail(`${what} must be text`);

    if (!ROUTER_ID.test(id)) {
        fail("id must be lowercase letters, digits, and dashes, starting with a letter or digit");
    }

    const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label.trim() : id;
    let model = "";

    if (typeof raw.model === "string" && raw.model.trim() !== "") {
        const ref = resolve(raw.model);

        model = `${ref.provider}/${ref.modelId}`;
    }

    const thinking = level(raw.thinking, "thinking");
    const extra = text(raw.extra, "extra");

    if (!Array.isArray(raw.pipeline) || raw.pipeline.length === 0) {
        fail("a router needs at least one stage");
    }

    if ((raw.pipeline as unknown[]).length > MAX_STAGES) {
        fail(`a router has at most ${MAX_STAGES} stages`);
    }

    const pipeline = (raw.pipeline as unknown[]).map((each, index): PipelineStage => {
        const stage = (typeof each === "object" && each !== null ? each : {}) as Record<
            string,
            unknown
        >;
        const where = `stage ${index + 1}`;
        const stageId = typeof stage.id === "string" ? stage.id.trim() : "";
        const template = stage.template as Template;

        if (!STAGE_ID.test(stageId)) {
            fail(`${where}'s id must be lowercase letters, digits, and dashes`);
        }

        if (!TEMPLATES.includes(template)) {
            fail(`${where}'s template must be one of ${TEMPLATES.join(", ")}`);
        }

        const stageModel = typeof stage.model === "string" ? stage.model.trim() : "";

        if (stageModel !== "" && !stageModel.includes("/")) {
            fail(`${where}'s model must be provider/modelId`);
        }

        const role = typeof stage.role === "string" && stage.role !== "" ? stage.role : undefined;

        if (role !== undefined && !roles.includes(role)) {
            fail(`${where}'s role ${role} is not one of your agent definitions`);
        }

        const named: unknown = stage.skills ?? [];

        if (
            !Array.isArray(named) ||
            named.length > MAX_SKILLS ||
            named.some((skill) => typeof skill !== "string" || !skills.includes(skill))
        ) {
            fail(`${where}'s skills must be skills installed here, at most ${MAX_SKILLS}`);
        }

        const stageThinking = level(stage.thinking, `${where}'s thinking`);

        return {
            id: stageId,
            name:
                typeof stage.name === "string" && stage.name.trim() !== ""
                    ? stage.name.trim()
                    : TEMPLATE_INFO[template].name,
            template,
            instructions:
                text(stage.instructions, `${where}'s instructions`)?.trim() ||
                TEMPLATE_INFO[template].instructions,
            ...((named as string[]).length === 0
                ? {}
                : { skills: [...new Set(named as string[])] }),
            ...(stageModel === "" ? {} : { model: stageModel }),
            ...(stageThinking === undefined ? {} : { thinking: stageThinking }),
            ...(role === undefined ? {} : { role }),
        };
    });
    const ids = pipeline.map((stage) => stage.id);

    if (new Set(ids).size !== ids.length) {
        fail("each stage needs its own id");
    }

    if (raw.dispatcher !== undefined && typeof raw.dispatcher !== "boolean") {
        fail(`router ${id}: dispatcher must be a boolean`);
    }

    return {
        id,
        label,
        model,
        ...(thinking === undefined ? {} : { thinking }),
        pipeline,
        ...(extra?.trim() ? { extra: extra.trim() } : {}),
        stages: {},
        ...(raw.dispatcher === true ? { dispatcher: true } : {}),
        source: "custom",
    };
}

export function saveRouter(dataDir: string, router: RouterConfig): void {
    mkdirSync(routersDir(dataDir), { recursive: true });
    const {
        source: _source,
        overrides: _overrides,
        from: _from,
        stages: _stages,
        ...kept
    } = router;

    writeFileSync(
        join(routersDir(dataDir), `${router.id}.json`),
        `${JSON.stringify(kept, null, 4)}\n`,
    );
}

/** Delete a saved router; true when there was one. A built-in or detected one with its id shows again. */
export function deleteRouter(dataDir: string, id: string): boolean {
    const file = join(routersDir(dataDir), `${id}.json`);

    if (!ROUTER_ID.test(id) || !existsSync(file)) {
        return false;
    }

    rmSync(file);

    return true;
}

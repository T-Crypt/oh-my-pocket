// The router editor, in the conversation's place (the rail's Routers button): every router, detected on this machine
// or saved here, and a form for one: its model, its prompt, and which model each stage role runs on. The owner saves;
// anyone may run a session as one.
import { useEffect, useState } from "preact/hooks";
import { actions, api, attempt, canSteer, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** Open the router editor in the conversation's place, or close it. */
export const toggleRouters = () =>
    store.set((state) =>
        state.routersOpen
            ? { routersOpen: false }
            : { routersOpen: true, board: false, boardAgents: null, drawer: false },
    );

const closeRouters = () => store.set({ routersOpen: false });

/** The roles a prompt names in backticks, as the server detects a router's stages. */
const named = (prompt, roles) => {
    const names = new Set(roles.map((role) => role.name));

    return new Set(
        [...(prompt ?? "").matchAll(/`([a-z0-9][a-z0-9_-]*)`/gi)]
            .map((match) => match[1])
            .filter((name) => names.has(name)),
    );
};

/** What the list says of where a router came from. */
function origin(router) {
    if (router.overrides) {
        return "edited";
    }

    return router.source === "detected" ? `detected · ${router.from}` : "custom";
}

/** A model picker as a select: every model people can pick, by provider, and the value even when not among them. */
function ModelSelect({ value, onChange, empty, label, disabled }) {
    const { models } = store.state;
    const groups = new Map();

    for (const model of models) {
        groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
    }

    const known = models.some((model) => `${model.provider}/${model.id}` === value);

    return html`<select
        class="router-model"
        aria-label=${label}
        value=${value ?? ""}
        disabled=${disabled}
        onChange=${(event) => onChange(event.currentTarget.value)}
    >
        ${empty !== undefined && html`<option value="">${empty}</option>`}
        ${value && !known && html`<option value=${value}>${value} (not signed in)</option>`}
        ${[...groups].map(
            ([provider, list]) => html`<optgroup label=${provider} key=${provider}>
                ${list.map(
                    (model) => html`<option value=${`${provider}/${model.id}`} key=${model.id}>
                        ${model.name ?? model.id}
                    </option>`,
                )}
            </optgroup>`,
        )}
    </select>`;
}

/** A router as the form edits it: its prompt as text or as a detected file, its stages as a copy. */
const draftOf = (router) => ({
    id: router.id,
    label: router.label,
    model: router.model,
    thinking: router.thinking ?? "",
    dispatcher: router.dispatcher === true,
    promptMode: router.promptFile && router.prompt === undefined ? "file" : "text",
    promptFile: router.promptFile ?? "",
    prompt: router.prompt ?? router.promptText ?? "",
    stages: { ...router.stages },
    stageThinking: { ...(router.stageThinking ?? {}) },
    isNew: false,
});

export function RouterEditor() {
    const { me, view, conversationId } = store.state;
    const owner = me?.role === "owner";
    const [data, setData] = useState(null);
    const [chosen, setChosen] = useState(null);
    const [draft, setDraft] = useState(null);
    const [saved, setSaved] = useState("");

    const load = async (pick) => {
        const answer = await attempt(() => api("routers"));

        if (answer) {
            setData(answer);
            const next =
                answer.routers.find((router) => router.id === (pick ?? chosen)) ??
                answer.routers[0];

            setChosen(next?.id ?? null);
            setDraft(next ? draftOf(next) : null);
        }
    };

    useEffect(() => {
        load();
    }, []);

    useEffect(() => {
        const onKey = (event) => event.key === "Escape" && closeRouters();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    const routers = data?.routers ?? [];
    const roles = data?.roles ?? [];
    const current = routers.find((router) => router.id === chosen);
    const prompts = routers.filter((router) => router.promptFile);
    const promptText =
        draft?.promptMode === "file"
            ? (prompts.find((router) => router.promptFile === draft.promptFile)?.promptText ?? "")
            : (draft?.prompt ?? "");
    const inPrompt = named(promptText, roles);
    // The roles the prompt names first, in the order it names them (a Set keeps it), then the rest.
    const rank = [...inPrompt];
    const place = (role) => (inPrompt.has(role.name) ? rank.indexOf(role.name) : rank.length);
    const ordered = [...roles].sort((a, b) => place(a) - place(b));

    const set = (change) => {
        setSaved("");
        setDraft((was) => ({ ...was, ...change }));
    };

    const pick = (router) => {
        setChosen(router.id);
        setDraft(draftOf(router));
        setSaved("");
    };

    const fresh = (from) => {
        // A new router starts with every stage on one model: this session's, or else the first there is. Each stage's
        // model and thinking are then the person's to change.
        const own = view.agent?.model;
        const first = store.state.models[0];
        const model = own
            ? `${own.provider}/${own.modelId}`
            : first
              ? `${first.provider}/${first.id}`
              : "";
        const base = from
            ? draftOf(from)
            : draftOf({
                  id: "",
                  label: "",
                  model,
                  stages: Object.fromEntries(roles.map((role) => [role.name, model])),
              });
        const id = from ? `${from.id}-copy` : "my-router";

        setChosen(null);
        setDraft({
            ...base,
            id,
            label: from ? `${from.label} copy` : "My router",
            promptMode: from ? base.promptMode : "file",
            // router-main's steps, as harnesses render them: a new router changes models, not the pipeline.
            promptFile: from
                ? base.promptFile
                : ((prompts.find((router) => router.id === "router-main") ?? prompts[0])
                      ?.promptFile ?? ""),
            isNew: true,
        });
        setSaved("");
    };

    const save = async () => {
        const router = {
            id: draft.id.trim(),
            label: draft.label.trim(),
            model: draft.model,
            ...(draft.thinking ? { thinking: draft.thinking } : {}),
            ...(draft.dispatcher ? { dispatcher: true } : {}),
            ...(draft.promptMode === "file"
                ? { promptFile: draft.promptFile }
                : { prompt: draft.prompt }),
            stages: Object.fromEntries(Object.entries(draft.stages).filter(([, model]) => model)),
            stageThinking: Object.fromEntries(
                Object.entries(draft.stageThinking).filter(([, level]) => level),
            ),
        };
        const answer = await attempt(() => api("routers", { router }));

        if (answer?.router) {
            await load(answer.router.id);
            setSaved(`Saved ${answer.router.label}.`);
        }
    };

    const remove = async () => {
        if (await attempt(() => api("routers/delete", { id: current.id }))) {
            await load(current.overrides ? current.id : undefined);
        }
    };

    const use = async () => {
        if (await attempt(() => actions.setRouter(current.id))) {
            setSaved(`This session runs as ${current.label} now.`);
        }
    };

    const editable = owner;
    const running = view.router?.id;

    return html`<section class="board routers" aria-label="Routers">
        <header class="board-head">
            <div class="board-title">
                <h2>Routers</h2>
                <div class="board-sub">
                    A router plans, implements, and reviews through stage subagents, each stage on the model you
                    choose.
                </div>
            </div>
            <button
                class="icon-button"
                title="Back to the conversation (Esc)"
                aria-label="Close"
                onClick=${closeRouters}
            >
                <${Icon} name="close" />
            </button>
        </header>
        <div class="routers-body">
            <nav class="routers-list" aria-label="Routers">
                ${data === null && html`<p class="muted small">Looking for routers…</p>`}
                ${routers.map(
                    (router) => html`<button
                        key=${router.id}
                        class=${`list-item ${router.id === chosen ? "on" : ""}`}
                        aria-current=${router.id === chosen ? "true" : undefined}
                        onClick=${() => pick(router)}
                    >
                        <span>
                            ${router.label}
                            ${running === router.id && html` <span class="ok small">· this session</span>`}
                        </span>
                        <span class="muted small">${router.id} · ${origin(router)}</span>
                    </button>`,
                )}
                ${
                    editable &&
                    html`<button class="button" onClick=${() => fresh()}>
                        <${Icon} name="plus" size=${14} /> New router
                    </button>`
                }
            </nav>
            ${
                draft &&
                html`<form
                    class="routers-form"
                    onSubmit=${(event) => {
                        event.preventDefault();
                        save();
                    }}
                >
                    <div class="routers-row">
                        <label>
                            <span class="label">Name</span>
                            <input
                                value=${draft.label}
                                disabled=${!editable}
                                onInput=${(event) => set({ label: event.currentTarget.value })}
                            />
                        </label>
                        <label>
                            <span class="label">Id</span>
                            <input
                                class="mono"
                                value=${draft.id}
                                disabled=${!editable || !draft.isNew}
                                title=${draft.isNew ? "" : "Saving under this id; duplicate to make another"}
                                onInput=${(event) => set({ id: event.currentTarget.value })}
                            />
                        </label>
                    </div>
                    <div class="routers-row">
                        <label>
                            <span class="label">Router model</span>
                            <${ModelSelect}
                                value=${draft.model}
                                label="Router model"
                                empty=${draft.model ? undefined : "Choose a model"}
                                disabled=${!editable}
                                onChange=${(model) =>
                                    // Stages that were on the router's model move with it.
                                    set({
                                        model,
                                        stages: Object.fromEntries(
                                            Object.entries(draft.stages).map(([role, each]) => [
                                                role,
                                                each === draft.model ? model : each,
                                            ]),
                                        ),
                                    })}
                            />
                        </label>
                        <label>
                            <span class="label">Thinking</span>
                            <select
                                value=${draft.thinking}
                                disabled=${!editable}
                                onChange=${(event) => set({ thinking: event.currentTarget.value })}
                            >
                                <option value="">as the session</option>
                                ${(data?.thinkingLevels ?? []).map(
                                    (level) =>
                                        html`<option value=${level} key=${level}>${level}</option>`,
                                )}
                            </select>
                        </label>
                    </div>
                    <label class="routers-check">
                        <input
                            type="checkbox"
                            checked=${draft.dispatcher}
                            disabled=${!editable}
                            onChange=${(event) => set({ dispatcher: event.currentTarget.checked })}
                        />
                        <span>
                            Dispatcher only
                            <span class="muted small">
                                The router itself may not run commands or change files; its stages do the work.
                            </span>
                        </span>
                    </label>
                    <div class="label">Prompt</div>
                    <div class="routers-row">
                        <label class="routers-check">
                            <input
                                type="radio"
                                name="prompt"
                                checked=${draft.promptMode === "file"}
                                disabled=${!editable || prompts.length === 0}
                                onChange=${() => set({ promptMode: "file", promptFile: draft.promptFile || prompts[0]?.promptFile || "" })}
                            />
                            <span>A detected router's prompt</span>
                        </label>
                        <label class="routers-check">
                            <input
                                type="radio"
                                name="prompt"
                                checked=${draft.promptMode === "text"}
                                disabled=${!editable}
                                onChange=${() => set({ promptMode: "text", prompt: draft.prompt || promptText })}
                            />
                            <span>Its own text</span>
                        </label>
                    </div>
                    ${
                        draft.promptMode === "file"
                            ? html`<select
                                  aria-label="Detected prompt"
                                  value=${draft.promptFile}
                                  disabled=${!editable}
                                  onChange=${(event) => set({ promptFile: event.currentTarget.value })}
                              >
                                  ${prompts.map(
                                      (
                                          router,
                                      ) => html`<option value=${router.promptFile} key=${router.promptFile}>
                                          ${router.id} · ${router.from} · ${router.promptFile}
                                      </option>`,
                                  )}
                              </select>
                              <p class="muted small">
                                  Read from its file at every request: when its harness renders it again, this router
                                  follows.
                              </p>`
                            : html`<textarea
                                  class="mono routers-prompt"
                                  aria-label="Router prompt"
                                  rows="12"
                                  value=${draft.prompt}
                                  disabled=${!editable}
                                  onInput=${(event) => set({ prompt: event.currentTarget.value })}
                              ></textarea>`
                    }
                    <div class="label">Stages</div>
                    <p class="muted small">
                        Each role keeps its instructions and tools; the model and thinking here are what its stage
                        runs with. Roles the prompt names come first.
                    </p>
                    <div class="routers-stages" role="group" aria-label="Stage models">
                        ${ordered.map(
                            (role) => html`<label class="routers-stage" key=${role.name}>
                                <span>
                                    <span class="mono">${role.name}</span>
                                    ${inPrompt.has(role.name) && html` <span class="ok small">in prompt</span>`}
                                    ${role.description && html`<span class="muted small routers-role">${role.description}</span>`}
                                </span>
                                <${ModelSelect}
                                    value=${draft.stages[role.name] ?? ""}
                                    label=${`Model for ${role.name}`}
                                    empty=${`as its definition: ${role.model ?? "the session's model"}`}
                                    disabled=${!editable}
                                    onChange=${(model) =>
                                        set({ stages: { ...draft.stages, [role.name]: model } })}
                                />
                                <select
                                    class="routers-thinking"
                                    aria-label=${`Thinking for ${role.name}`}
                                    value=${draft.stageThinking[role.name] ?? ""}
                                    disabled=${!editable}
                                    onChange=${(event) =>
                                        set({
                                            stageThinking: {
                                                ...draft.stageThinking,
                                                [role.name]: event.currentTarget.value,
                                            },
                                        })}
                                >
                                    <option value="">role's thinking</option>
                                    ${(data?.thinkingLevels ?? []).map(
                                        (level) => html`<option value=${level} key=${level}>
                                            ${level}
                                        </option>`,
                                    )}
                                </select>
                            </label>`,
                        )}
                    </div>
                    <div class="routers-actions">
                        ${
                            editable &&
                            html`<button class="button primary" type="submit">Save</button>`
                        }
                        ${
                            editable &&
                            current &&
                            html`<button class="button" type="button" onClick=${() => fresh(current)}>
                                Duplicate
                            </button>`
                        }
                        ${
                            editable &&
                            current?.source === "custom" &&
                            html`<button class="button" type="button" onClick=${remove}>
                                ${current.overrides ? "Back to detected" : "Delete"}
                            </button>`
                        }
                        ${
                            current &&
                            !draft.isNew &&
                            conversationId !== null &&
                            canSteer() &&
                            html`<button class="button" type="button" onClick=${use}>
                                Use in this session
                            </button>`
                        }
                        ${saved && html`<span class="muted small" role="status">${saved}</span>`}
                    </div>
                </form>`
            }
        </div>
    </section>`;
}

// The router editor, in the conversation's place (the rail's Routers button, or the Routers place on a phone). A
// router is its fit check (the router's own model) and its stages, in order: each a card with its job, the skills it
// reads first, its model, and its effort. Routers found on this machine show read-only, and only where they exist.
// On a phone the list and one router take the screen in turn.
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

/** A model picker as a select: every model people can pick, by provider, and the value even when not among them. */
function ModelSelect({ value, onChange, empty, label, disabled }) {
    const { models } = store.state;
    const groups = new Map();

    for (const model of models) {
        groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
    }

    const known = models.some((model) => `${model.provider}/${model.id}` === value);

    return html`<select
        aria-label=${label}
        value=${value ?? ""}
        disabled=${disabled}
        onChange=${(event) => onChange(event.currentTarget.value)}
    >
        <option value="">${empty}</option>
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

function EffortSelect({ value, onChange, levels, label, empty, disabled }) {
    return html`<select
        aria-label=${label}
        value=${value ?? ""}
        disabled=${disabled}
        onChange=${(event) => onChange(event.currentTarget.value)}
    >
        <option value="">${empty}</option>
        ${levels.map((level) => html`<option value=${level} key=${level}>${level}</option>`)}
    </select>`;
}

/** The skills a stage reads first, as chips; `/` in the box lists the installed ones that match what follows it. */
function SkillPicker({ value, skills, onChange, disabled, label }) {
    const [text, setText] = useState("");
    const query = text.startsWith("/") ? text.slice(1).toLowerCase() : null;
    const matches =
        query === null
            ? []
            : skills
                  .filter((skill) => !value.includes(skill.name))
                  .filter((skill) => skill.name.toLowerCase().includes(query))
                  .slice(0, 8);

    const add = (name) => {
        onChange([...value, name]);
        setText("");
    };

    return html`<div class="router-skills">
        <div class="router-skill-chips">
            ${value.map(
                (name) => html`<span class="router-skill" key=${name}>
                    /${name}
                    ${
                        !disabled &&
                        html`<button
                            type="button"
                            aria-label=${`Remove ${name}`}
                            onClick=${() => onChange(value.filter((each) => each !== name))}
                        >
                            <${Icon} name="close" size=${11} />
                        </button>`
                    }
                </span>`,
            )}
        </div>
        ${
            !disabled &&
            html`<input
                aria-label=${label}
                placeholder=${skills.length === 0 ? "No skills installed" : "Type / to add a skill"}
                disabled=${skills.length === 0}
                value=${text}
                onInput=${(event) => setText(event.currentTarget.value)}
                onKeyDown=${(event) => {
                    if (event.key === "Enter" && matches[0]) {
                        event.preventDefault();
                        add(matches[0].name);
                    } else if (event.key === "Escape") {
                        setText("");
                    }
                }}
            />`
        }
        ${
            matches.length > 0 &&
            html`<div class="router-skill-menu" role="listbox" aria-label="Installed skills">
                ${matches.map(
                    (skill) => html`<button
                        type="button"
                        role="option"
                        key=${skill.name}
                        onClick=${() => add(skill.name)}
                    >
                        <span class="mono">/${skill.name}</span>
                        <span class="muted small">${skill.description}</span>
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}

/** A router as the form edits it. */
const draftOf = (router) => ({
    id: router.id,
    label: router.label,
    model: router.model ?? "",
    thinking: router.thinking ?? "",
    dispatcher: router.dispatcher === true,
    extra: router.extra ?? "",
    pipeline: (router.pipeline ?? []).map((stage) => ({ ...stage, skills: stage.skills ?? [] })),
    isNew: false,
});

/** A stage id not yet taken in the pipeline: the template's name, then numbered. */
const freeId = (pipeline, base) => {
    let id = base;

    for (let n = 2; pipeline.some((stage) => stage.id === id); n++) {
        id = `${base}-${n}`;
    }

    return id;
};

/** One stage's card: its name, job, skills, model, effort, and (advanced) a role file to run instead. */
function StageCard({ stage, index, count, editable, data, levels, setStage, move, remove }) {
    return html`<div class="router-card">
        <div class="router-card-head">
            <b>${index + 1}</b>
            <input
                class="router-stage-name"
                aria-label=${`Stage ${index + 1} name`}
                value=${stage.name}
                disabled=${!editable}
                onInput=${(event) => setStage({ name: event.currentTarget.value })}
            />
            <span class="muted small">${stage.template}</span>
            ${
                editable &&
                html`<span class="router-card-tools">
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="Move up"
                        disabled=${index === 0}
                        onClick=${() => move(-1)}
                    >
                        <${Icon} name="down" size=${14} class="router-up" />
                    </button>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="Move down"
                        disabled=${index === count - 1}
                        onClick=${() => move(1)}
                    >
                        <${Icon} name="down" size=${14} />
                    </button>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label=${`Remove ${stage.name}`}
                        disabled=${count === 1}
                        onClick=${remove}
                    >
                        <${Icon} name="close" size=${14} />
                    </button>
                </span>`
            }
        </div>
        <label>
            <span class="label">What it does</span>
            <textarea
                rows="3"
                aria-label=${`${stage.name}: what it does`}
                value=${stage.instructions}
                disabled=${!editable || Boolean(stage.role)}
                onInput=${(event) => setStage({ instructions: event.currentTarget.value })}
            ></textarea>
        </label>
        <div>
            <span class="label">Skills it reads first</span>
            <${SkillPicker}
                value=${stage.skills}
                skills=${data?.skills ?? []}
                label=${`${stage.name}: add a skill`}
                disabled=${!editable}
                onChange=${(skills) => setStage({ skills })}
            />
        </div>
        <div class="routers-row">
            <label>
                <span class="label">Model</span>
                <${ModelSelect}
                    value=${stage.model ?? ""}
                    label=${`Model for ${stage.name}`}
                    empty="The router's model"
                    disabled=${!editable}
                    onChange=${(model) => setStage({ model })}
                />
            </label>
            <label>
                <span class="label">Effort</span>
                <${EffortSelect}
                    value=${stage.thinking ?? ""}
                    levels=${levels}
                    label=${`Effort for ${stage.name}`}
                    empty="Default"
                    disabled=${!editable}
                    onChange=${(thinking) => setStage({ thinking })}
                />
            </label>
        </div>
        ${
            (data?.roles ?? []).length > 0 &&
            html`<details class="router-advanced" open=${Boolean(stage.role)}>
                <summary class="muted small">Advanced: run one of your role files instead</summary>
                <select
                    aria-label=${`${stage.name}: role file`}
                    value=${stage.role ?? ""}
                    disabled=${!editable}
                    onChange=${(event) => setStage({ role: event.currentTarget.value })}
                >
                    <option value="">None: the words above</option>
                    ${data.roles.map(
                        (role) =>
                            html`<option value=${role.name} key=${role.name}>${role.name}</option>`,
                    )}
                </select>
            </details>`
        }
    </div>`;
}

export function RouterEditor() {
    const { me, view, conversationId } = store.state;
    const owner = me?.role === "owner";
    const [data, setData] = useState(null);
    const [chosen, setChosen] = useState(null);
    const [draft, setDraft] = useState(null);
    const [saved, setSaved] = useState("");
    const [adding, setAdding] = useState("custom");

    const load = async (pick) => {
        const answer = await attempt(() => api("routers"));

        if (answer) {
            setData(answer);
            const next = pick && answer.routers.find((router) => router.id === pick);

            setChosen(next ? next.id : null);
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
    const levels = data?.thinkingLevels ?? [];
    const templates = data?.templates ?? {};
    const yours = routers.filter((router) => router.source !== "detected");
    const found = routers.filter((router) => router.source === "detected");
    const current = routers.find((router) => router.id === chosen);
    const readOnly = draft !== null && !draft.isNew && current?.pipeline === undefined;
    const editable = owner && draft !== null && !readOnly;

    const set = (change) => {
        setSaved("");
        setDraft((was) => ({ ...was, ...change }));
    };

    const setStage = (index, change) =>
        set({
            pipeline: draft.pipeline.map((stage, at) =>
                at === index ? { ...stage, ...change } : stage,
            ),
        });

    const move = (index, step) => {
        const pipeline = [...draft.pipeline];
        const [stage] = pipeline.splice(index, 1);

        pipeline.splice(index + step, 0, stage);
        set({ pipeline });
    };

    const pick = (router) => {
        setChosen(router.id);
        setDraft(draftOf(router));
        setSaved("");
    };

    // A new router, or an editable copy: the built-in pipeline's stages (or the copied router's), every stage on the
    // router's model until changed. The router's model starts as the copied one's, or this session's.
    const fresh = (from) => {
        const standard = routers.find((router) => router.id === "standard");
        const base = from?.pipeline ? from : standard;
        const own = view.agent?.model;

        setChosen(null);
        setDraft({
            ...draftOf(base ?? { id: "", label: "", pipeline: [] }),
            id: from ? `${from.id}-copy` : "my-router",
            label: from ? `${from.label} copy` : "My router",
            model: from?.model || (own ? `${own.provider}/${own.modelId}` : ""),
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
            ...(draft.extra.trim() ? { extra: draft.extra } : {}),
            pipeline: draft.pipeline.map((stage) => ({
                id: stage.id,
                name: stage.name,
                template: stage.template,
                instructions: stage.instructions,
                ...(stage.skills.length > 0 ? { skills: stage.skills } : {}),
                ...(stage.model ? { model: stage.model } : {}),
                ...(stage.thinking ? { thinking: stage.thinking } : {}),
                ...(stage.role ? { role: stage.role } : {}),
            })),
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

    const back = () => {
        setChosen(null);
        setDraft(null);
    };

    const running = view.router?.id;
    const useButton =
        current &&
        !draft?.isNew &&
        conversationId !== null &&
        canSteer() &&
        html`<button class="button" type="button" onClick=${use}>Use in this session</button>`;
    const item = (router) => html`<button
        key=${router.id}
        class=${`list-item ${router.id === chosen ? "on" : ""}`}
        aria-current=${router.id === chosen ? "true" : undefined}
        onClick=${() => pick(router)}
    >
        <span>
            ${router.label}
            ${running === router.id && html` <span class="ok small">· this session</span>`}
        </span>
        <span class="muted small">
            ${
                router.pipeline
                    ? router.pipeline.map((stage) => stage.name).join(" → ")
                    : `${router.from} · ${router.id}`
            }
        </span>
    </button>`;

    return html`<section class="board routers" aria-label="Routers">
        <header class="board-head">
            ${
                draft &&
                html`<button class="icon-button routers-back" aria-label="All routers" onClick=${back}>
                    <${Icon} name="back" />
                </button>`
            }
            <div class="board-title">
                <h2>${draft ? draft.label || "Router" : "Routers"}</h2>
                <div class="board-sub">
                    A router checks each task, then runs it through its stages, each on the model you pick.
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
        <div class=${`routers-body ${draft ? "picked" : ""}`}>
            <nav class="routers-list" aria-label="Routers">
                ${data === null && html`<p class="muted small">Looking for routers…</p>`}
                ${yours.map(item)}
                ${
                    owner &&
                    data !== null &&
                    html`<button class="button" onClick=${() => fresh()}>
                        <${Icon} name="plus" size=${14} /> New router
                    </button>`
                }
                ${
                    found.length > 0 &&
                    html`<details class="routers-found">
                        <summary class="muted small">From this machine (${found.length})</summary>
                        ${found.map(item)}
                    </details>`
                }
            </nav>
            ${
                readOnly &&
                html`<div class="routers-form">
                    <p class="muted small">
                        Found in ${current.from}: its prompt file sets its steps, and it runs as it is. Make an
                        editable router from it to change stages, models, and skills.
                    </p>
                    <div class="label">Prompt</div>
                    <p class="mono small">${current.promptFile}</p>
                    <div class="label">Model</div>
                    <p class="small">${current.model || "this session's model"}</p>
                    ${
                        Object.keys(current.stages).length > 0 &&
                        html`<div class="label">Roles its prompt uses</div>
                            ${Object.entries(current.stages).map(
                                ([role, model]) => html`<div key=${role} class="small">
                                    <span class="mono">${role}</span><span class="muted"> · ${model}</span>
                                </div>`,
                            )}`
                    }
                    <div class="routers-actions">
                        ${
                            owner &&
                            html`<button class="button" type="button" onClick=${() => fresh(current)}>
                                Make an editable router from it
                            </button>`
                        }
                        ${useButton}
                        ${saved && html`<span class="muted small" role="status">${saved}</span>`}
                    </div>
                </div>`
            }
            ${
                draft &&
                !readOnly &&
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
                        ${
                            draft.isNew &&
                            html`<label>
                                <span class="label">Id</span>
                                <input
                                    class="mono"
                                    value=${draft.id}
                                    onInput=${(event) => set({ id: event.currentTarget.value })}
                                />
                            </label>`
                        }
                    </div>
                    <div class="routers-flow" aria-label="The pipeline">
                        <span>Prompt</span>
                        <span>Fit check</span>
                        ${draft.pipeline.map((stage) => html`<span key=${stage.id}>${stage.name}</span>`)}
                    </div>
                    <div class="router-card">
                        <div class="router-card-head">
                            <b>Fit check</b>
                            <span class="muted small">
                                The router itself: answers questions, or picks the stages a task needs.
                            </span>
                        </div>
                        <div class="routers-row">
                            <label>
                                <span class="label">Model</span>
                                <${ModelSelect}
                                    value=${draft.model}
                                    label="Router model"
                                    empty="This session's model"
                                    disabled=${!editable}
                                    onChange=${(model) => set({ model })}
                                />
                            </label>
                            <label>
                                <span class="label">Effort</span>
                                <${EffortSelect}
                                    value=${draft.thinking}
                                    levels=${levels}
                                    label="Router effort"
                                    empty="As the session"
                                    disabled=${!editable}
                                    onChange=${(thinking) => set({ thinking })}
                                />
                            </label>
                        </div>
                    </div>
                    ${draft.pipeline.map(
                        (stage, index) => html`<${StageCard}
                            key=${stage.id}
                            stage=${stage}
                            index=${index}
                            count=${draft.pipeline.length}
                            editable=${editable}
                            data=${data}
                            levels=${levels}
                            setStage=${(change) => setStage(index, change)}
                            move=${(step) => move(index, step)}
                            remove=${() =>
                                set({ pipeline: draft.pipeline.filter((_, at) => at !== index) })}
                        />`,
                    )}
                    ${
                        editable &&
                        draft.pipeline.length < 12 &&
                        html`<div class="routers-add">
                            <select
                                aria-label="New stage's template"
                                value=${adding}
                                onChange=${(event) => setAdding(event.currentTarget.value)}
                            >
                                ${Object.entries(templates).map(
                                    ([
                                        template,
                                        info,
                                    ]) => html`<option value=${template} key=${template}>
                                        ${info.name}
                                    </option>`,
                                )}
                            </select>
                            <button
                                type="button"
                                class="button"
                                onClick=${() =>
                                    set({
                                        pipeline: [
                                            ...draft.pipeline,
                                            {
                                                id: freeId(draft.pipeline, adding),
                                                name: templates[adding].name,
                                                template: adding,
                                                instructions: templates[adding].instructions,
                                                skills: [],
                                            },
                                        ],
                                    })}
                            >
                                <${Icon} name="plus" size=${14} /> Add stage
                            </button>
                        </div>`
                    }
                    <details class="router-advanced">
                        <summary class="muted small">Advanced</summary>
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
                                    The router runs no commands and changes no files itself.
                                </span>
                            </span>
                        </label>
                        <label>
                            <span class="label">More for the router</span>
                            <textarea
                                rows="3"
                                aria-label="More for the router"
                                placeholder="Anything else the router should always do"
                                value=${draft.extra}
                                disabled=${!editable}
                                onInput=${(event) => set({ extra: event.currentTarget.value })}
                            ></textarea>
                        </label>
                    </details>
                    <div class="routers-actions">
                        ${editable && html`<button class="button primary" type="submit">Save</button>`}
                        ${
                            owner &&
                            current &&
                            !draft.isNew &&
                            html`<button class="button" type="button" onClick=${() => fresh(current)}>
                                Duplicate
                            </button>`
                        }
                        ${
                            owner &&
                            current?.source === "custom" &&
                            !draft.isNew &&
                            html`<button class="button" type="button" onClick=${remove}>
                                ${current.overrides ? "Back to the original" : "Delete"}
                            </button>`
                        }
                        ${useButton}
                        ${saved && html`<span class="muted small" role="status">${saved}</span>`}
                    </div>
                </form>`
            }
        </div>
    </section>`;
}

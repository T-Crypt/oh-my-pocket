// Subagents for this session: which models they may run on besides the session's own. Opened from the message box's
// Subagents chip or `/subagents`. The server keeps the choice (`SubagentPolicyDoc`); Pi cannot change it.
import { useState } from "preact/hooks";
import { actions, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Sheet } from "../ui.js";

/** Models past this many get a box to find them by. */
const MODEL_SEARCH_AT = 8;

const MODES = [
    {
        mode: "auto",
        label: "Auto",
        hint: "Roles on this session's provider run on their own models; any other role runs on this session's model",
    },
    {
        mode: "own",
        label: "This session's model",
        hint: "Every subagent runs on the model you picked here",
    },
    { mode: "local", label: "Local roles", hint: "Every agent definition runs on its own model" },
    {
        mode: "custom",
        label: "Choose models…",
        hint: "Only the models you check, besides this session's",
    },
];

/** What `/subagents <words>` asks for: a mode, or models to choose. */
export function subagentsRequest(arg) {
    const words = arg
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);

    if (
        words.length === 1 &&
        MODES.some((each) => each.mode === words[0] && each.mode !== "custom")
    ) {
        return { mode: words[0] };
    }

    return { mode: "custom", models: words };
}

export function SubagentsSheet() {
    const { view, models } = store.state;
    const policy = view.subagentPolicy ?? { mode: "auto", models: [], allowed: [] };
    const [choosing, setChoosing] = useState(policy.mode === "custom");
    const [picked, setPicked] = useState(policy.models ?? []);
    const [query, setQuery] = useState("");
    const own = view.agent?.model;
    const ownSpec = own ? `${own.provider}/${own.modelId}` : "";

    const set = (request) =>
        attempt(async () => {
            await actions.setSubagents(request);
            closeSheet();
        });

    if (!choosing) {
        return html`<${Sheet} title="Subagents in this session" onClose=${closeSheet}>
            <p class="muted small subagents-now">
                ${
                    policy.allowed.length === 0
                        ? "Now: every subagent runs on this session's model."
                        : `Now: subagents may also run on ${policy.allowed.join(", ")}.`
                }
            </p>
            ${MODES.map(
                ({ mode, label, hint }) => html`<button
                    class=${`list-item ${policy.mode === mode ? "on" : ""}`}
                    key=${mode}
                    aria-pressed=${policy.mode === mode}
                    onClick=${() => (mode === "custom" ? setChoosing(true) : set({ mode }))}
                >
                    <span>${policy.mode === mode && html`<${Icon} name="check" size=${14} />`} ${label}</span>
                    <span class="muted small">${hint}</span>
                </button>`,
            )}
        <//>`;
    }

    const specOf = (model) => `${model.provider}/${model.id}`;
    const needle = query.trim().toLowerCase();
    const rows = models
        .filter((model) => specOf(model) !== ownSpec)
        .filter(
            (model) =>
                needle === "" ||
                `${specOf(model)} ${model.name ?? ""}`.toLowerCase().includes(needle),
        );
    const groups = new Map();

    for (const model of rows) {
        groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
    }

    const toggle = (spec, on) =>
        setPicked((was) =>
            on ? [...new Set([...was, spec])] : was.filter((each) => each !== spec),
        );

    return html`<${Sheet} title="Models for subagents here" onClose=${closeSheet}>
        <div class="subagent-models">
            <p class="muted small">
                Subagents run on this session's model, or on one you check. ${picked.length} checked.
            </p>
            ${
                (models.length > MODEL_SEARCH_AT || query !== "") &&
                html`<label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        placeholder="Find a model"
                        aria-label="Find a model for subagents"
                        value=${query}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </label>`
            }
            <div class="subagent-models-list" role="group" aria-label="Models for subagents here">
                ${groups.size === 0 && html`<p class="muted small">No model matches.</p>`}
                ${[...groups].map(
                    ([provider, list]) => html`<div key=${provider}>
                        <div class="subagent-models-head">${provider}</div>
                        ${list.map(
                            (model) => html`<label class="subagent-model" key=${specOf(model)}>
                                <input
                                    type="checkbox"
                                    value=${specOf(model)}
                                    checked=${picked.includes(specOf(model))}
                                    onChange=${(event) =>
                                        toggle(specOf(model), event.currentTarget.checked)}
                                />
                                <span>
                                    ${model.name ?? model.id}
                                    <span class="muted small">${specOf(model)}</span>
                                </span>
                            </label>`,
                        )}
                    </div>`,
                )}
            </div>
            <button class="button primary" onClick=${() => set({ mode: "custom", models: picked })}>
                Save
            </button>
        </div>
    <//>`;
}

// Model providers: signing in and out, the models subagents may use besides their session's own, and the models
// each one offers the pickers (the chat's model menu, the default model, and every other place a model is chosen).
// The dialog a sign-in uses to ask for a code or a key is here too.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, closeSignIn, signInAnswered, store } from "../store.js";
import { html, Icon, Loader, Sheet, Switch } from "../ui.js";

/** How many of a provider's models the list shows at once. The search field reaches the rest. */
const MODELS_AT_ONCE = 50;

/** Models past this many get a box to find them by. */
const MODEL_SEARCH_AT = 8;

/** This tab's changes to the models for subagents, one after another: their answers come back in the order sent. */
let saving = Promise.resolve();

/**
 * The owner's choice of the models Pi may start subagents on besides their session's own: every model, by provider,
 * each checked or not on its own. None, the default: subagents always run on their session's model, and Pi is offered
 * no model to pick. A tap sends that one model's change, not the whole list, so quick taps and other tabs keep theirs.
 * `names`: providers' names by id, once the sheet has them.
 */
function SubagentModels({ names }) {
    const { models, server } = store.state;
    const allowed = server?.subagentModels;
    // What this tab asked for and has no answer to yet, by model: shown at once.
    const [asked, setAsked] = useState({});
    const [query, setQuery] = useState("");

    // A server that does not keep the choice sends none.
    if (!Array.isArray(allowed)) {
        return null;
    }

    const specOf = (model) => `${model.provider}/${model.id}`;
    // Allowed models that are not signed in now are listed too, so they can be seen and taken off.
    const rows = [
        ...models.map((model) => ({ spec: specOf(model), model })),
        ...allowed
            .filter((spec) => !models.some((model) => specOf(model) === spec))
            .map((spec) => ({ spec, model: null })),
    ];
    const isOn = (spec) => asked[spec] ?? allowed.includes(spec);
    const chosen = rows.filter((row) => isOn(row.spec)).map((row) => row.model?.name ?? row.spec);
    const summary =
        chosen.length === 0
            ? "None allowed: Pi never picks a model."
            : `${chosen.length} allowed: ${chosen.join(", ")}`;
    const needle = query.trim().toLowerCase();
    const groups = new Map();

    for (const row of rows) {
        const provider = row.spec.slice(0, row.spec.indexOf("/"));
        const words = `${row.spec} ${row.model?.name ?? ""} ${names[provider] ?? ""}`;

        if (needle === "" || words.toLowerCase().includes(needle)) {
            groups.set(provider, [...(groups.get(provider) ?? []), row]);
        }
    }

    const toggle = (spec, on) => {
        setAsked((was) => ({ ...was, [spec]: on }));
        saving = saving.then(async () => {
            const answer = await attempt(() =>
                api("subagent-models", { model: spec, allowed: on }),
            );

            if (Array.isArray(answer?.subagentModels)) {
                store.set((state) => ({
                    server: { ...state.server, subagentModels: answer.subagentModels },
                }));
            }

            // Unless a later tap asked otherwise, what the server says shows now.
            setAsked((was) => {
                if (was[spec] !== on) {
                    return was;
                }

                const rest = { ...was };

                delete rest[spec];

                return rest;
            });
        });
    };

    return html`<div class="subagent-models">
        <div class="label">Models for subagents</div>
        <p class="muted small">
            Allowed here, a model is open to subagents in every session. Each session also has its own choice: the Subagents chip by the message box, or /subagents.
        </p>
        <p class="small subagent-models-chosen" title=${summary}>${summary}</p>
        ${
            (rows.length > MODEL_SEARCH_AT || query !== "") &&
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
        <div class="subagent-models-list" role="group" aria-label="Models for subagents">
            ${
                groups.size === 0 &&
                html`<p class="muted small">
                    ${rows.length === 0 ? "No models: sign in to a provider below." : "No model matches."}
                </p>`
            }
            ${[...groups].map(
                ([provider, list]) => html`<div key=${provider}>
                    <div class="subagent-models-head">${names[provider] ?? provider}</div>
                    ${list.map(
                        ({ spec, model }) => html`<label class="subagent-model" key=${spec}>
                            <input
                                type="checkbox"
                                value=${spec}
                                checked=${isOn(spec)}
                                onChange=${(event) => toggle(spec, event.currentTarget.checked)}
                            />
                            <span>
                                ${model?.name ?? spec.slice(spec.indexOf("/") + 1)}
                                <span class="muted small">
                                    ${spec}
                                    ${
                                        !model
                                            ? html` · <span class="warn">not signed in</span>`
                                            : model.signIn &&
                                              html` · <span class="warn">needs sign-in</span>`
                                    }
                                </span>
                            </span>
                        </label>`,
                    )}
                </div>`,
            )}
        </div>
    </div>`;
}

export function ProvidersSheet() {
    const { me } = store.state;
    const [providers, setProviders] = useState(null);
    const [query, setQuery] = useState("");
    // The provider whose models are open, with every model it has and whether the pickers offer it.
    const [open, setOpen] = useState(null);
    const [search, setSearch] = useState("");
    const load = () => attempt(async () => setProviders(await api("providers")));

    useEffect(() => {
        load();
    }, [store.state.models]);
    const owner = me?.role === "owner";
    const path = (provider, after = "") => `providers/${encodeURIComponent(provider.id)}${after}`;
    const login = (provider, type) => attempt(() => api(path(provider, "/login"), { type }));
    const logout = (provider) =>
        confirm(
            `Log out of ${provider.name}? Pi uses the same sign-in, so it is signed out too.`,
        ) &&
        attempt(async () => {
            await api(path(provider, "/logout"), {});
            load();
        });

    const showModels = (provider) => {
        if (open?.id === provider.id) {
            setOpen(null);

            return;
        }

        return attempt(async () => {
            const { models } = await api(path(provider, "/models"));

            setSearch("");
            setOpen({ id: provider.id, models });
        });
    };

    // What the pickers offer from now on: model ids, or null for every model the provider has (the same as never
    // choosing).
    const offer = (provider, models) =>
        attempt(async () => {
            const answer = await api(path(provider, "/models"), { models });

            setProviders(answer.providers);
            setOpen({ id: provider.id, models: answer.models });
        });
    const chosen = () => open.models.filter((model) => model.shown).map((model) => model.id);

    const toggle = (provider, model) => {
        const ids = chosen();

        return offer(
            provider,
            model.shown ? ids.filter((id) => id !== model.id) : [...ids, model.id],
        );
    };

    const needle = query.trim().toLowerCase();
    const list = (providers ?? [])
        .filter(
            (provider) =>
                needle === "" || `${provider.id} ${provider.name}`.toLowerCase().includes(needle),
        )
        .sort(
            (a, b) =>
                Number(Boolean(b.needsSignIn)) - Number(Boolean(a.needsSignIn)) ||
                Number(b.configured) - Number(a.configured) ||
                a.name.localeCompare(b.name),
        );
    const models = open?.models ?? [];
    const wanted = search.trim().toLowerCase();
    const found = models.filter(
        (model) => wanted === "" || `${model.id} ${model.name}`.toLowerCase().includes(wanted),
    );
    const listed = found.slice(0, MODELS_AT_ONCE);
    const shown = models.filter((model) => model.shown).length;

    return html`<${Sheet} title="Providers" onClose=${closeSheet}>
        <p class="muted small">
            Pi Pocket shares Pi's sign-ins (<span class="mono">~/.pi/agent/auth.json</span>). ${owner ? "" : "Only the owner can change them."}
        </p>
        ${
            owner &&
            html`<${SubagentModels}
                names=${Object.fromEntries((providers ?? []).map((each) => [each.id, each.name]))}
            />`
        }
        <label class="search">
            <${Icon} name="search" size=${16} />
            <input
                placeholder="Search providers"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </label>
        ${providers === null && html`<${Loader} label="Loading providers" />`}
        ${list.map(
            (provider) => html`<div class="provider-block">
                <div class="provider">
                    <div>
                        ${provider.name}
                        ${
                            provider.needsSignIn
                                ? html` <span class="warn">needs sign-in</span>`
                                : provider.configured && html` <span class="ok">✓</span>`
                        }
                    </div>
                    <div class="muted small">
                        ${provider.needsSignIn ? "the sign-in expired and could not be renewed: sign in again. Until then, sessions on its models fail, and PiP and subagents on other models do not use them" : provider.configured ? `signed in${provider.label ? ` · ${provider.label}` : provider.source ? ` · ${provider.source}` : ""}` : "not configured"} · ${
                            provider.shown === provider.models
                                ? `${provider.models} models`
                                : `${provider.shown} of ${provider.models} models shown`
                        }
                    </div>
                    ${
                        provider.needsSignIn &&
                        html`<div class="muted small mono provider-why">${provider.needsSignIn}</div>`
                    }
                </div>
                    ${
                        owner &&
                        html`<div class="provider-actions">
                            ${
                                provider.oauth &&
                                html`<button
                                    class="button small"
                                    onClick=${() => login(provider, "oauth")}
                                >
                                    ${provider.oauth}
                                </button>`
                            }
                            ${
                                provider.apiKey &&
                                html`<button
                                    class="button small"
                                    onClick=${() => login(provider, "api_key")}
                                >
                                    API key
                                </button>`
                            }
                            ${
                                provider.configured &&
                                html`<button
                                    class="button small ghost"
                                    title="Choose which of this provider's models the pickers offer"
                                    onClick=${() => showModels(provider)}
                                >
                                    Models
                                </button>`
                            }
                            ${
                                provider.configured &&
                                provider.source === "stored" &&
                                html`<button
                                    class="button small ghost"
                                    onClick=${() => logout(provider)}
                                >
                                    Log out
                                </button>`
                            }
                        </div>`
                    }
                </div>
                ${
                    open?.id === provider.id &&
                    html`<div class="provider-models">
                        <label class="search">
                            <${Icon} name="search" size=${16} />
                            <input
                                placeholder="Search models"
                                value=${search}
                                onInput=${(event) => setSearch(event.currentTarget.value)}
                            />
                        </label>
                        <div class="row">
                            <span class="muted small">${shown} of ${models.length} shown</span>
                            <span class="grow"></span>
                            <button
                                class="button small ghost"
                                onClick=${() => offer(provider, null)}
                            >
                                All
                            </button>
                            <button class="button small ghost" onClick=${() => offer(provider, [])}>
                                None
                            </button>
                        </div>
                        ${listed.map(
                            (model) => html`<div class="setting">
                                <div class="grow">
                                    <div class="small">${model.name}</div>
                                    <div class="muted small mono">${model.id}</div>
                                </div>
                                <${Switch}
                                    on=${model.shown}
                                    label=${`Offer ${model.name} in the model pickers`}
                                    onChange=${() => toggle(provider, model)}
                                />
                            </div>`,
                        )}
                        ${
                            listed.length === 0 &&
                            html`<p class="muted small">No model matches “${search.trim()}”.</p>`
                        }
                        ${
                            found.length > listed.length &&
                            html`<p class="muted small">Showing the first ${MODELS_AT_ONCE} of ${found.length}. Search to narrow them.</p>`
                        }
                    </div>`
                }
            </div>`,
        )}
    <//>`;
}

export function AuthDialog() {
    const { auth } = store.state;
    const [value, setValue] = useState("");

    // Each question starts empty, also one that came before the reply to the answer before it.
    useEffect(() => setValue(""), [auth?.flowId, auth?.prompt?.id]);

    if (!auth) {
        return null;
    }

    const answer = (payload) => {
        const { flowId, prompt: asked } = auth;

        return attempt(async () => {
            await api(`auth/${flowId}/${asked.id}`, payload);
            signInAnswered(flowId, asked.id);
        });
    };

    const close = () => {
        // Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
        if (!auth.done) {
            api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
        }

        closeSignIn(auth.flowId);
    };

    const prompt = auth.prompt;

    return html`<${Sheet} title=${`Sign in: ${auth.providerName}`} onClose=${close}>
        ${auth.events.map((event) => {
            if (event.type === "auth_url") {
                return html`<div class="auth-event">
                    <a class="button primary wide" href=${event.url} target="_blank" rel="noopener">
                        Open the sign-in page
                    </a>
                    ${event.instructions && html`<p class="muted small">${event.instructions}</p>`}
                </div>`;
            }

            if (event.type === "device_code") {
                return html`<div class="auth-event">
                    <p>
                        Enter this code at <a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a>
                    </p>
                    <div class="code-big">${event.userCode}</div>
                </div>`;
            }

            return html`<p class="muted small">
                ${event.message}
                ${event.links?.map(
                    (link) => html` <a href=${link.url} target="_blank" rel="noopener">
     ${link.label ?? link.url}
 </a>`,
                )}
            </p>`;
        })}
        ${
            prompt &&
            (prompt.type === "select"
                ? html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    ${prompt.options.map(
                        (option) =>
                            html`<button
                                class="list-item"
                                onClick=${() => answer({ value: option.id })}
                            >
                                <span>${option.label}</span>
                                <span class="muted small">${option.description ?? ""}</span>
                            </button>`,
                    )}
                </div>`
                : html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    <div class="row">
                        <input
                            type=${prompt.type === "secret" ? "password" : "text"}
                            autocomplete="off"
                            placeholder=${prompt.placeholder ?? ""}
                            value=${value}
                            onInput=${(event) => setValue(event.currentTarget.value)}
                            onKeyDown=${(event) => event.key === "Enter" && answer({ value })}
                        />
                        <button class="button primary" onClick=${() => answer({ value })}>
                            Continue
                        </button>
                    </div>
                </div>`)
        }
        ${!prompt && !auth.done && html`<${Loader} label="Waiting for the provider" />`}
        ${auth.done && !auth.done.ok && html`<div class="error-box">${auth.done.error}</div>`}
    <//>`;
}

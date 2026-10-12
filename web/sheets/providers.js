// Model providers: signing in and out, and the models each one offers the pickers (the chat's model menu, the default
// model, and every other place a model is chosen). The dialog a sign-in uses to ask for a code or a key is here too.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, Switch } from "../ui.js";

/** How many of a provider's models the list shows at once. The search field reaches the rest. */
const MODELS_AT_ONCE = 50;

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
            (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
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
                        <div>
                            ${provider.name} ${provider.configured && html`<span class="ok">✓</span>`}
                        </div>
                        <div class="muted small">
                            ${provider.configured ? `signed in${provider.label ? ` · ${provider.label}` : provider.source ? ` · ${provider.source}` : ""}` : "not configured"} · ${
                                provider.shown === provider.models
                                    ? `${provider.models} models`
                                    : `${provider.shown} of ${provider.models} models shown`
                            }
                        </div>
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

    if (!auth) {
        return null;
    }

    const answer = (payload) =>
        attempt(async () => {
            await api(`auth/${auth.flowId}/${auth.prompt.id}`, payload);
            setValue("");
            store.set({ auth: { ...store.state.auth, prompt: null } });
        });

    const close = () => {
        // Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
        if (!auth.done) {
            api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
        }

        store.set({ auth: null });
    };

    const prompt = auth.prompt;

    return html`<${Sheet} title=${`Sign in: ${auth.providerId}`} onClose=${close}>
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

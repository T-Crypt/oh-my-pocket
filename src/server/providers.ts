/**
 * Model providers: which ones Pi knows, whether each is signed in, and sign-ins run from the app. A sign-in asks its
 * questions (an API key, a code, a choice) through the tabs of the person who started it. Pi Pocket shares Pi's own
 * sign-ins (`~/.pi/agent/auth.json`).
 */
import { randomUUID } from "node:crypto";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { modelList } from "./models.ts";

interface AuthFlow {
    id: string;
    userId: string;
    prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
    abort: AbortController;
}

export class Providers {
    readonly #app: PocketApp;
    readonly #flows = new Map<string, AuthFlow>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    list() {
        const models = this.#app.models;

        return models.getProviders().map((provider) => {
            const status = models.getProviderAuthStatus(provider.id);
            const auth = (
                provider as {
                    auth?: { apiKey?: unknown; oauth?: { name?: string; loginLabel?: string } };
                }
            ).auth;
            const catalog = models.getModels(provider.id);

            return {
                id: provider.id,
                name: provider.name,
                configured: status.configured,
                source: status.source ?? null,
                label: status.label ?? null,
                apiKey: auth?.apiKey !== undefined,
                oauth:
                    auth?.oauth === undefined
                        ? null
                        : (auth.oauth.loginLabel ?? auth.oauth.name ?? "Subscription"),
                models: catalog.length,
                // The models the pickers offer (`shown` of `models`); the owner narrows them from the sheet.
                shown: catalog.filter((model) => this.#app.config.showsModel(provider.id, model.id))
                    .length,
            };
        });
    }

    /** A provider's whole catalog, by id, with whether the pickers offer each model. */
    modelsFor(providerId: string): { id: string; name: string; shown: boolean }[] {
        const provider = this.#provider(providerId);

        return this.#app.models
            .getModels(provider.id)
            .map((model) => ({
                id: model.id,
                name: model.name,
                shown: this.#app.config.showsModel(provider.id, model.id),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * What a provider offers the pickers from now on. `models` are ids from its catalog, or null for every one of
     * them. Nothing else about a model changes. One that is not offered still runs in a session that has it, and
     * `/model` still takes it by name.
     */
    setVisible(providerId: string, models: readonly string[] | null): void {
        const provider = this.#provider(providerId);

        if (models !== null) {
            const known = new Set(this.#app.models.getModels(provider.id).map((each) => each.id));
            const unknown = models.find((id) => !known.has(id));

            if (unknown !== undefined) {
                throw new HttpError(400, `No such model: ${provider.id}/${unknown}`);
            }
        }

        this.#app.config.setVisibleModels(provider.id, models);
        this.#sendModels();
    }

    /** A provider the model runtime knows, by id. */
    #provider(id: string) {
        const provider = this.#app.models.getProviders().find((each) => each.id === id);

        if (provider === undefined) {
            throw new HttpError(404, "No such provider");
        }

        return provider;
    }

    startLogin(user: User, providerId: string, type: "api_key" | "oauth"): string {
        const app = this.#app;
        const flow: AuthFlow = {
            id: randomUUID(),
            userId: user.id,
            prompts: new Map(),
            abort: new AbortController(),
        };

        this.#flows.set(flow.id, flow);

        const send = (data: Record<string, unknown>) => {
            for (const client of app.clients) {
                if (client.user.id === user.id) {
                    client.send("auth", { flowId: flow.id, providerId, ...data });
                }
            }
        };

        const interaction = {
            signal: flow.abort.signal,
            prompt: (prompt: AuthPrompt) =>
                new Promise<string>((resolvePrompt, rejectPrompt) => {
                    const promptId = randomUUID();

                    flow.prompts.set(promptId, { resolve: resolvePrompt, reject: rejectPrompt });
                    const { signal, ...shown } = prompt;

                    signal?.addEventListener("abort", () => {
                        flow.prompts.delete(promptId);
                        send({ step: "prompt-closed", promptId });
                        rejectPrompt(new Error("cancelled"));
                    });
                    send({ step: "prompt", promptId, prompt: shown });
                }),
            notify: (event: unknown) => send({ step: "event", event }),
        };

        void app.models
            // Sign-ins that identify the installation (ChatGPT) get the ID Pi keeps for it, the same as Pi's own login.
            .login(providerId, type, interaction, {
                getDeviceId: () => app.settings.getOrCreateDeviceId(),
            })
            .then(
                async () => {
                    await app.models.getAvailable().catch(() => []);
                    send({ step: "done", ok: true });
                    this.#sendModels();
                },
                (error: unknown) => send({ step: "done", ok: false, error: describe(error) }),
            )
            .finally(() => this.#flows.delete(flow.id));

        return flow.id;
    }

    answerLogin(user: User, flowId: string, promptId: string, value: string | undefined): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            throw new HttpError(404, "No such login");
        }

        const prompt = flow.prompts.get(promptId);

        if (prompt === undefined) {
            throw new HttpError(404, "No such prompt");
        }

        flow.prompts.delete(promptId);

        if (value === undefined) {
            prompt.reject(new Error("cancelled"));
            flow.abort.abort();
        } else {
            prompt.resolve(value);
        }
    }

    /** Stop a sign-in its person gave up on, whether or not it is asking something. */
    cancelLogin(user: User, flowId: string): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            return;
        }

        for (const prompt of flow.prompts.values()) {
            prompt.reject(new Error("cancelled"));
        }

        flow.prompts.clear();
        flow.abort.abort();
    }

    async logout(providerId: string): Promise<void> {
        await this.#app.models.logout(providerId);
        await this.#app.models.getAvailable().catch(() => []);
        this.#sendModels();
    }

    /** Every tab gets the models available now. */
    #sendModels(): void {
        const models = modelList(this.#app.models, this.#app.config);

        for (const client of this.#app.clients) {
            client.send("models", models);
        }
    }

    close(): void {
        for (const flow of this.#flows.values()) {
            flow.abort.abort();
        }
    }
}

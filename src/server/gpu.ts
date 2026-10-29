/**
 * One GPU, many sessions. A llama-swap server keeps one model on the card: a request for another model swaps it, 20 to
 * 40 seconds each way, and requests that alternate between two models swap on every turn. The lab's load log showed
 * 17 model changes on busy days, 10 to 13 of them within ten minutes of the one before.
 *
 * The lane orders this server's own requests to each llama-swap: requests for the model on the card go on, those for
 * another model wait until it is done and then go together. A session works in turns, with tools running between
 * them, so after an answer that called tools the card stays its model's for a short grace: the session's next turn
 * finds it there instead of a swap. An answer that ends the run hands the card on at once. A model that keeps another waiting longer than the hold stops taking new requests until the other
 * has had its turn, so nothing waits for ever. Role names (agent, router)
 * count as the model they stand for, read from llama-swap's /v1/models, which loads nothing.
 *
 * It also says what a request waits for (`status`: a swap, or a model still loading), and can start loading a model a
 * person is about to use (`warm`), when the card is not busy with another.
 */

/** What llama-swap says about one model: the model a name stands for, and whether it is on the card. */
export type SwapModel = { physical: string; state: string };

/** What the GPU is doing for this server, for the status line: empty when nothing waits. */
export type GpuStatus = {
    /** The model the lane serves now, when requests are in flight. */
    serving?: string;
    /** Models whose requests wait for the card, oldest first, with how many and since when. */
    waiting: { model: string; count: number; since: number }[];
    /** Models a request waits on while llama-swap loads them. */
    loading: string[];
};

/** How long llama-swap's model list is trusted before it is read again. */
const LIST_MS = 10_000;

/** How long a model may keep another waiting before it takes no new requests. */
export const HOLD_MS = 60_000;
/** How long the card stays a model's after an answer that called tools, for the same session's next turn. */
export const GRACE_MS = 10_000;
/** A warm-up is asked for at most once in this long, per model. */
const WARM_EVERY_MS = 120_000;

/** One llama-swap server, as its model list describes it. */
export class LlamaSwap {
    readonly #base: string;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    #list: { at: number; models: Map<string, SwapModel> | null } | undefined;
    #reading: Promise<Map<string, SwapModel> | null> | undefined;

    /** `base`: the provider's OpenAI base URL, `http://host:port/v1`. */
    constructor(base: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
        this.#base = base.replace(/\/+$/, "");
        this.#fetch = fetchImpl;
        this.#now = now;
    }

    /** Every name llama-swap answers to, aliases included; null when this is not a llama-swap (or it does not answer). */
    async models(fresh = false): Promise<Map<string, SwapModel> | null> {
        if (!fresh && this.#list !== undefined && this.#now() - this.#list.at < LIST_MS) {
            return this.#list.models;
        }

        this.#reading ??= this.#read().finally(() => {
            this.#reading = undefined;
        });

        return this.#reading;
    }

    async #read(): Promise<Map<string, SwapModel> | null> {
        let models: Map<string, SwapModel> | null = null;

        try {
            const response = await this.#fetch(`${this.#base}/models`, {
                signal: AbortSignal.timeout(3000),
            });
            const body = (await response.json()) as {
                data?: {
                    id?: unknown;
                    owned_by?: unknown;
                    meta?: { llamaswap?: { aliases?: unknown } };
                    status?: { value?: unknown };
                }[];
            };

            if (
                Array.isArray(body.data) &&
                body.data.some((model) => model.owned_by === "llama-swap")
            ) {
                models = new Map();

                for (const model of body.data) {
                    if (typeof model.id !== "string") {
                        continue;
                    }

                    const entry = {
                        physical: model.id,
                        state:
                            typeof model.status?.value === "string"
                                ? model.status.value
                                : "unknown",
                    };
                    const aliases = model.meta?.llamaswap?.aliases;

                    models.set(model.id, entry);

                    for (const alias of Array.isArray(aliases) ? aliases : []) {
                        if (typeof alias === "string" && !models.has(alias)) {
                            models.set(alias, entry);
                        }
                    }
                }
            }
        } catch {
            // Not answering, or not llama-swap: requests go straight to it.
        }

        this.#list = { at: this.#now(), models };

        return models;
    }

    /** Ask llama-swap to load a model, as a request for it would; what it answers does not matter. */
    warm(physical: string): void {
        const root = this.#base.replace(/\/v1$/, "");

        void this.#fetch(`${root}/upstream/${encodeURIComponent(physical)}/health`, {
            signal: AbortSignal.timeout(300_000),
        })
            .then((response) => response.body?.cancel())
            .catch(() => {});
    }
}

/** Requests for one card, in turns by model. */
export class GpuLane {
    readonly #hold: number;
    readonly #grace: number;
    readonly #now: () => number;
    readonly #changed: () => void;
    #current: string | undefined;
    #inFlight = 0;
    /** When the card's last request ended: its model keeps it for the grace after that. */
    #endedAt = Number.NEGATIVE_INFINITY;
    #timer: NodeJS.Timeout | undefined;
    readonly #waiting: { model: string; at: number; go: () => void }[] = [];

    constructor(
        options: {
            holdMs?: number;
            graceMs?: number;
            now?: () => number;
            onChange?: () => void;
        } = {},
    ) {
        this.#hold = options.holdMs ?? HOLD_MS;
        this.#grace = options.graceMs ?? GRACE_MS;
        this.#now = options.now ?? Date.now;
        this.#changed = options.onChange ?? (() => {});
    }

    /** The model on the card for this lane, while requests are in flight. */
    get serving(): string | undefined {
        return this.#inFlight > 0 ? this.#current : undefined;
    }

    get busy(): boolean {
        return this.#inFlight > 0;
    }

    /** Waiting requests by model, oldest model first. */
    waiting(): { model: string; count: number; since: number }[] {
        const byModel = new Map<string, { model: string; count: number; since: number }>();

        for (const entry of this.#waiting) {
            const known = byModel.get(entry.model);

            if (known === undefined) {
                byModel.set(entry.model, { model: entry.model, count: 1, since: entry.at });
            } else {
                known.count++;
            }
        }

        return [...byModel.values()];
    }

    /**
     * Wait for this model's turn on the card. Resolves to the release, to call once the request is done, with `again`
     * when the run goes on (the answer called tools): then the model keeps the card for the grace. A request aborted
     * while it waits stops waiting and holds nothing (it then fails on its own signal).
     */
    acquire(model: string, signal?: AbortSignal): Promise<(again?: boolean) => void> {
        if (this.#mayGo(model)) {
            return Promise.resolve(this.#take(model));
        }

        return new Promise((resolve) => {
            const entry = { model, at: this.#now(), go: () => resolve(this.#take(model)) };

            this.#waiting.push(entry);
            signal?.addEventListener(
                "abort",
                () => {
                    const index = this.#waiting.indexOf(entry);

                    if (index >= 0) {
                        this.#waiting.splice(index, 1);
                        resolve(() => {});
                        this.#changed();
                    }
                },
                { once: true },
            );
            this.#changed();
        });
    }

    /** Whether the model on the card may keep it: another has not waited past the hold. */
    #keeps(model: string): boolean {
        const other = this.#waiting.find((entry) => entry.model !== model);

        return other === undefined || this.#now() - other.at < this.#hold;
    }

    #mayGo(model: string): boolean {
        if (model !== this.#current) {
            return this.#inFlight === 0 && this.#waiting.length === 0 && !this.#inGrace();
        }

        return (
            this.#keeps(model) &&
            (this.#inFlight > 0 || this.#inGrace() || this.#waiting.length === 0)
        );
    }

    #inGrace(): boolean {
        return this.#inFlight === 0 && this.#now() - this.#endedAt < this.#grace;
    }

    #take(model: string): (again?: boolean) => void {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#current = model;
        this.#inFlight++;
        this.#changed();

        let released = false;

        return (again = false) => {
            if (released) {
                return;
            }

            released = true;
            this.#inFlight--;

            if (this.#inFlight === 0) {
                this.#endedAt = again ? this.#now() : Number.NEGATIVE_INFINITY;
            }

            this.#next();
        };
    }

    /**
     * Once the card is free: after the grace (or at once, when the model on it has had more than its hold), the model
     * that has waited longest goes, with every request for it.
     */
    #next(): void {
        clearTimeout(this.#timer);
        this.#timer = undefined;

        if (this.#inFlight > 0 || this.#waiting.length === 0) {
            this.#changed();

            return;
        }

        const oldest = this.#waiting[0]!;
        const graceLeft = this.#grace - (this.#now() - this.#endedAt);
        const holdLeft = this.#hold - (this.#now() - oldest.at);
        const wait = oldest.model === this.#current ? 0 : Math.min(graceLeft, holdLeft);

        if (wait > 0) {
            this.#timer = setTimeout(() => this.#next(), wait);
            this.#changed();

            return;
        }

        const model = oldest.model;
        const going = this.#waiting.filter((entry) => entry.model === model);

        for (const entry of going) {
            this.#waiting.splice(this.#waiting.indexOf(entry), 1);
        }

        for (const entry of going) {
            entry.go();
        }

        this.#changed();
    }
}

/** A model as a request names it: what the lane needs to know about it. */
type RequestModel = { id: string; api?: string; baseUrl?: string };

/** Every llama-swap this server talks to, each with its lane, and what they all wait for. */
export class Gpu {
    readonly #swaps = new Map<string, { view: LlamaSwap; lane: GpuLane }>();
    readonly #loading = new Map<string, number>();
    readonly #warmed = new Map<string, number>();
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #hold: number;
    readonly #listeners = new Set<() => void>();

    readonly #grace: number;

    constructor(
        options: {
            fetch?: typeof fetch;
            now?: () => number;
            holdMs?: number;
            graceMs?: number;
        } = {},
    ) {
        this.#fetch = options.fetch ?? fetch;
        this.#now = options.now ?? Date.now;
        this.#hold = options.holdMs ?? HOLD_MS;
        this.#grace = options.graceMs ?? GRACE_MS;
    }

    /** Hear when the status changes. Returns how to stop. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #changed(): void {
        for (const listener of [...this.#listeners]) {
            listener();
        }
    }

    /** Only OpenAI-style providers on http can be a llama-swap. */
    static may(model: RequestModel): boolean {
        return model.api === "openai-completions" && /^https?:\/\//.test(model.baseUrl ?? "");
    }

    #swap(base: string) {
        let swap = this.#swaps.get(base);

        if (swap === undefined) {
            swap = {
                view: new LlamaSwap(base, this.#fetch, this.#now),
                lane: new GpuLane({
                    holdMs: this.#hold,
                    graceMs: this.#grace,
                    now: this.#now,
                    onChange: () => this.#changed(),
                }),
            };
            this.#swaps.set(base, swap);
        }

        return swap;
    }

    /**
     * Wait for a request's turn on its llama-swap's card. Resolves to the release (a no-op for anything that is not a
     * llama-swap model), and to `started`, to call at the first token: until then a model llama-swap is still loading
     * shows as loading.
     */
    async acquire(
        model: RequestModel,
        signal?: AbortSignal,
    ): Promise<{ release: (again?: boolean) => void; started: () => void }> {
        const none = { release: () => {}, started: () => {} };

        if (!Gpu.may(model)) {
            return none;
        }

        const { view, lane } = this.#swap(model.baseUrl!);
        const models = await view.models();
        const known = models?.get(model.id);

        if (models === null || known === undefined) {
            return none;
        }

        const release = await lane.acquire(known.physical, signal);
        const physical = known.physical;
        // Read again: what was loaded may have gone while this waited.
        const loaded = (await view.models(true))?.get(physical)?.state === "ready";

        if (!loaded) {
            this.#loading.set(physical, (this.#loading.get(physical) ?? 0) + 1);
            this.#changed();
        }

        let started = loaded;

        const start = () => {
            if (started) {
                return;
            }

            started = true;

            const left = (this.#loading.get(physical) ?? 1) - 1;

            if (left <= 0) {
                this.#loading.delete(physical);
            } else {
                this.#loading.set(physical, left);
            }

            this.#changed();
        };

        return {
            started: start,
            release: (again?: boolean) => {
                start();
                release(again);
            },
        };
    }

    /**
     * Start loading a model a person is about to use: only a llama-swap model that is not on the card, while its lane
     * has nothing in flight (a warm-up must never push out another session's work), and at most every two minutes.
     */
    async warm(model: RequestModel): Promise<boolean> {
        if (!Gpu.may(model)) {
            return false;
        }

        const { view, lane } = this.#swap(model.baseUrl!);
        const known = (await view.models())?.get(model.id);

        if (known === undefined || known.state === "ready" || lane.busy) {
            return false;
        }

        const last = this.#warmed.get(known.physical) ?? Number.NEGATIVE_INFINITY;

        if (this.#now() - last < WARM_EVERY_MS) {
            return false;
        }

        this.#warmed.set(known.physical, this.#now());
        view.warm(known.physical);

        return true;
    }

    status(): GpuStatus {
        const lanes = [...this.#swaps.values()].map(({ lane }) => lane);

        return {
            ...(lanes.find((lane) => lane.serving !== undefined)?.serving === undefined
                ? {}
                : { serving: lanes.find((lane) => lane.serving !== undefined)!.serving! }),
            waiting: lanes.flatMap((lane) => lane.waiting()),
            loading: [...this.#loading.keys()],
        };
    }
}

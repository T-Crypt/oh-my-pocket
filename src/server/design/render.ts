/** Private, short-lived Chromium renders. No shared page, profile, or sign-in cookie reaches a design. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chromium, type Json } from "../browser/cdp.ts";
import { findBrowser, profileFolder } from "../browser/discovery.ts";
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";

export const VIEWPORTS = {
    mobile: { width: 390, height: 844 },
    tablet: { width: 820, height: 1180 },
    desktop: { width: 1280, height: 800 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;
export type DesignViewport = { width: number; height: number };
const LIMIT_MS = 90_000;
// Keep the /a/ page policy and add a separate, stricter render-only policy. CSP policies intersect.
const ARTIFACT_CSP =
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads; frame-ancestors 'self'";
const RENDER_CSP =
    "sandbox allow-scripts allow-modals; frame-src 'none'; worker-src 'none'; object-src 'none'; connect-src http: https:;";
let active = 0;

/** The default slide size of a deck, as the canvas lays slides out. */
export const SLIDE_SIZE: DesignViewport = { width: 1920, height: 1080 };

/** A `pocket-slide-size` value (`WxH`, each 320 to 3840), or the default for anything else. */
export function parseSlideSize(value: string): DesignViewport {
    const match = /^\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*$/i.exec(value);

    if (match === null) {
        return SLIDE_SIZE;
    }

    const width = Number(match[1]);
    const height = Number(match[2]);

    if (width < 320 || height < 320 || width > 3840 || height > 3840) {
        return SLIDE_SIZE;
    }

    return { width, height };
}

export function viewportOf(value: string | DesignViewport = "desktop"): DesignViewport {
    if (typeof value === "string") {
        if (Object.hasOwn(VIEWPORTS, value)) {
            return VIEWPORTS[value as ViewportName];
        }

        const match = /^(\d{3,4})x(\d{3,4})$/.exec(value);

        if (match === null) {
            throw new Error("Viewport must be mobile, tablet, desktop, or WIDTHxHEIGHT.");
        }

        value = { width: Number(match[1]), height: Number(match[2]) };
    }

    if (
        !Number.isInteger(value.width) ||
        !Number.isInteger(value.height) ||
        value.width < 320 ||
        value.width > 2560 ||
        value.height < 240 ||
        value.height > 2560
    ) {
        throw new Error("Viewport must be 320–2560 pixels wide and 240–2560 pixels tall.");
    }

    return { ...value };
}

/** Only this bundle is available. A random bearer path expires when the render ends. */
export async function serveBundle(bundle: DesignBundle) {
    const token = randomBytes(32).toString("hex");
    const prefix = `/${token}/a/`;
    const assets = new Map(bundle.assets.map((asset) => [asset.name, asset]));
    const server = createServer((request, response) => {
        let url: URL;
        let name: string;

        try {
            url = new URL(request.url ?? "/", "http://127.0.0.1");
            name = decodeURIComponent(url.pathname.slice(prefix.length));
        } catch {
            response.writeHead(400).end();

            return;
        }

        if (
            !url.pathname.startsWith(prefix) ||
            (request.method !== "GET" && request.method !== "HEAD")
        ) {
            response.writeHead(404).end();

            return;
        }

        const asset = assets.get(name);

        if (name !== "" && asset === undefined) {
            response.writeHead(404).end();

            return;
        }

        response.writeHead(200, {
            "content-type": asset?.type ?? "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "access-control-allow-origin": "*",
            "x-content-type-options": "nosniff",
            // No popups, workers, frames, or sockets can bypass the page's request interception.
            "content-security-policy": `${ARTIFACT_CSP}, ${RENDER_CSP}`,
        });
        response.end(request.method === "HEAD" ? undefined : (asset?.bytes ?? bundle.content));
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (address === null || typeof address === "string") {
        server.close();

        throw new Error("The private render server did not start.");
    }

    return {
        url: `http://127.0.0.1:${address.port}${prefix}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

export class DesignPage {
    readonly errors: string[] = [];
    readonly failedRequests: string[] = [];
    readonly #browser: Chromium;
    readonly #session: string;
    readonly #url: string;
    readonly #host: PocketHost;
    readonly #signal: AbortSignal;
    #requests = 0;
    #pending = 0;
    #networkBytes = 0;
    #slideDisplays: string[] | undefined;

    constructor(
        browser: Chromium,
        session: string,
        url: string,
        host: PocketHost,
        signal: AbortSignal,
    ) {
        this.#browser = browser;
        this.#session = session;
        this.#url = url;
        this.#host = host;
        this.#signal = signal;
        browser.connection.listen(session, (method, params) => this.#event(method, params));
    }

    #record(list: string[], text: string): void {
        if (list.length < 100) {
            list.push(text.slice(0, 2000));
        }
    }

    #event(method: string, params: Json): void {
        if (method === "Fetch.requestPaused") {
            void this.#request(params).catch(() => {});
        } else if (method === "Runtime.exceptionThrown") {
            const error = params.exceptionDetails;

            this.#record(this.errors, String(error?.exception?.description ?? error?.text));
        } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
            this.#record(
                this.errors,
                (params.args ?? [])
                    .map((arg: Json) => String(arg.value ?? arg.description ?? arg.type))
                    .join(" "),
            );
        } else if (method === "Network.loadingFailed") {
            this.#record(this.failedRequests, String(params.errorText));
        } else if (method === "Network.responseReceived" && params.response?.status >= 400) {
            this.#record(this.failedRequests, `${params.response.status} ${params.response.url}`);
        } else if (method === "Page.javascriptDialogOpening") {
            void this.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
        }
    }

    async #request(params: Json): Promise<void> {
        const url = String(params.request.url);
        const id = params.requestId;
        let external = false;

        try {
            if (++this.#requests > 400) {
                throw new Error("The design exceeded 400 requests.");
            }

            if (url === new URL("/favicon.ico", this.#url).href) {
                await this.send("Fetch.fulfillRequest", { requestId: id, responseCode: 204 });

                return;
            }

            // Only the token-scoped bundle bypasses the public-network guard. Redirects go through Fetch again.
            if (url.startsWith(this.#url) && /^(GET|HEAD)$/.test(params.request.method)) {
                await this.send("Fetch.continueRequest", { requestId: id });

                return;
            }

            if (params.resourceType === "Document") {
                throw new Error(
                    "External document navigation is disabled during design rendering.",
                );
            }

            if (new URL(url).protocol !== "https:") {
                throw new Error("External design resources must use public HTTPS addresses.");
            }

            if (!/^(GET|HEAD)$/.test(params.request.method)) {
                throw new Error("Preview requests must use GET or HEAD.");
            }

            if (this.#pending >= 20 || this.#networkBytes >= 50_000_000) {
                throw new Error("The design exceeded its external request budget.");
            }

            this.#pending++;
            external = true;
            // Fetch on the server pins DNS and rejects private addresses at every connection and redirect.
            // No browser cookies, credentials, or authorization headers are forwarded.
            const response = await this.#host.fetchPublic(url, {
                method: params.request.method,
                signal: this.#signal,
                redirect: "manual",
                maxBytes: 5_000_000,
                timeoutMs: 10_000,
            });
            const bytes = Buffer.from(await response.arrayBuffer());

            this.#networkBytes += bytes.length;

            if (this.#networkBytes > 50_000_000) {
                throw new Error("The design exceeded 50 MB of external resources.");
            }

            const headers = [...response.headers]
                .filter(
                    ([name]) =>
                        !["set-cookie", "content-encoding", "content-length"].includes(name),
                )
                .map(([name, value]) => ({ name, value }));

            await this.send("Fetch.fulfillRequest", {
                requestId: id,
                responseCode: response.status,
                responseHeaders: headers,
                body: bytes.toString("base64"),
            });
        } catch (error) {
            this.#record(this.failedRequests, `${url}: ${String(error)}`);
            await this.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" });
        } finally {
            if (external) {
                this.#pending--;
            }
        }
    }

    send(method: string, params: Record<string, unknown> = {}): Promise<Json> {
        this.#signal.throwIfAborted();

        return this.#browser.connection.send(method, params, this.#session, 15_000);
    }

    async evaluate(expression: string): Promise<Json> {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: 10_000,
        });

        if (result.exceptionDetails !== undefined) {
            throw new Error(
                String(result.exceptionDetails.exception?.description ?? "Render script failed."),
            );
        }

        return result.result?.value;
    }

    async load(viewport: DesignViewport): Promise<void> {
        this.#slideDisplays = undefined;
        await this.send("Emulation.setDeviceMetricsOverride", {
            ...viewport,
            deviceScaleFactor: 1,
            mobile: viewport.width < 500,
        });
        const result = await this.send("Page.navigate", { url: this.#url });

        if (result.errorText) {
            throw new Error(String(result.errorText));
        }

        // Readiness is bounded even when an image, font, or page request never finishes.
        for (let attempt = 0; attempt < 50; attempt++) {
            if ((await this.evaluate("document.readyState")) === "complete") {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await this.evaluate(`Promise.race([
            Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))]),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    }

    async init(): Promise<void> {
        // Network APIs outside Fetch interception must be unavailable before any untrusted script runs.
        await this.send("Page.addScriptToEvaluateOnNewDocument", {
            source: `(() => {
                for (const name of Object.getOwnPropertyNames(globalThis)) {
                    if (/^(RTC|webkitRTC)/.test(name) || name === 'WebTransport') {
                        Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
                    }
                }
            })();`,
        });
        await this.send("DOM.enable");
        await this.send("CSS.enable");
        await Promise.all([
            this.send("Page.enable"),
            this.send("Runtime.enable"),
            this.send("Network.enable"),
            this.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
            this.send("Browser.setDownloadBehavior", { behavior: "deny" }),
        ]);
    }

    async screenshot(viewport: DesignViewport, fullPage = false, preview = false): Promise<string> {
        const metrics = fullPage ? await this.send("Page.getLayoutMetrics") : undefined;
        const content = metrics?.cssContentSize;
        // A full page is cut at a bound; a viewport (a slide up to 3840 a side) is taken whole.
        const width =
            content === undefined ? viewport.width : Math.min(2560, Math.ceil(content.width));
        const height =
            content === undefined ? viewport.height : Math.min(16000, Math.ceil(content.height));
        const scale = preview ? Math.min(1, 2000 / Math.max(width, height)) : 1;
        const result = await this.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale },
        });

        return String(result.data);
    }

    async isDeck(): Promise<boolean> {
        return (
            (await this.evaluate(
                `document.querySelector('meta[name="pocket-kind"]')?.content === 'deck'`,
            )) === true
        );
    }

    /**
     * The size a deck's slides are written at, as the canvas lays them out (`artifact-inspect.ts`): 1920×1080, or the
     * page's `<meta name="pocket-slide-size" content="WxH">`.
     */
    async slideSize(): Promise<DesignViewport> {
        const value = await this.evaluate(
            `document.querySelector('meta[name="pocket-slide-size"]')?.content ?? ''`,
        );

        return parseSlideSize(typeof value === "string" ? value : "");
    }

    async pdf(): Promise<string> {
        if (await this.isDeck()) {
            await this.slides();
            const displays = await this.#displays();
            const { width, height } = await this.slideSize();

            await this.evaluate(`(() => {
                document.getElementById('pocket-render-slide')?.remove();
                const slides = Array.from(document.querySelectorAll('section.slide'));
                const displays = ${JSON.stringify(displays)};
                document.body.replaceChildren(...slides);
                slides.forEach((slide, index) => {
                    slide.hidden = false;
                    slide.style.setProperty('display', displays[index] === 'none' ? 'block' : displays[index], 'important');
                });
                const style = document.createElement('style');
                style.textContent = '@page{size:${width}px ${height}px;margin:0}html,body{margin:0!important;padding:0!important;width:${width}px!important;height:auto!important;overflow:visible!important}section.slide{position:relative!important;inset:auto!important;width:${width}px!important;height:${height}px!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;margin:0!important;overflow:hidden!important;box-sizing:border-box!important;transform:none!important;scale:1!important;break-after:page!important;break-inside:avoid!important}section.slide:last-child{break-after:auto!important}';
                document.head.append(style);
            })()`);
        }

        const result = await this.send("Page.printToPDF", {
            printBackground: true,
            preferCSSPageSize: true,
            transferMode: "ReturnAsBase64",
        });

        return String(result.data);
    }

    async slides(): Promise<string[]> {
        const result = await this.evaluate(`(() => {
            if (document.querySelector('meta[name="pocket-kind"]')?.content !== 'deck') return null;
            return Array.from(document.querySelectorAll('section.slide'), slide => (slide.textContent ?? '').slice(0, 20000));
        })()`);

        if (!Array.isArray(result) || result.length === 0 || result.length > 100) {
            throw new Error("A deck needs pocket-kind=deck and 1–100 section.slide elements.");
        }

        return result.map(String);
    }

    /** DevTools exposes matched rules even for cross-origin stylesheets and inactive slides. */
    async #displays(): Promise<string[]> {
        if (this.#slideDisplays !== undefined) {
            return this.#slideDisplays;
        }

        const computed = await this.evaluate(
            `Array.from(document.querySelectorAll('section.slide'), slide => getComputedStyle(slide).display)`,
        );
        const document = await this.send("DOM.getDocument");
        const nodes = await this.send("DOM.querySelectorAll", {
            nodeId: document.root.nodeId,
            selector: "section.slide",
        });
        const displays: string[] = [];

        for (const [index, nodeId] of nodes.nodeIds.entries()) {
            if (computed[index] !== "none") {
                displays.push(String(computed[index]));
                continue;
            }

            const matched = await this.send("CSS.getMatchedStylesForNode", { nodeId });
            const declarations = [
                ...matched.matchedCSSRules.flatMap((match: Json) => match.rule.style.cssProperties),
                ...(matched.inlineStyle?.cssProperties ?? []),
            ].filter(
                (property: Json) =>
                    property.name === "display" &&
                    property.value !== "none" &&
                    property.disabled !== true &&
                    property.parsedOk !== false,
            );
            const chosen =
                declarations.filter((property: Json) => property.important).at(-1) ??
                declarations.at(-1);

            displays.push(String(chosen?.value ?? "block"));
        }

        this.#slideDisplays = displays;

        return displays;
    }

    /** Show one slide (from 1), laid out at the deck's slide size and scaled to fit `viewport` (default: that size). */
    async showSlide(slide: number, viewport?: DesignViewport): Promise<void> {
        const slides = await this.slides();
        const size = await this.slideSize();

        viewport ??= size;

        if (!Number.isInteger(slide) || slide < 1 || slide > slides.length) {
            throw new Error(`Slide must be between 1 and ${slides.length}.`);
        }

        const displays = await this.#displays();
        const scale = Math.min(viewport.width / size.width, viewport.height / size.height);
        const left = (viewport.width - size.width * scale) / 2;
        const top = (viewport.height - size.height * scale) / 2;

        await this.evaluate(`(() => {
            document.getElementById('pocket-render-slide')?.remove();
            const visibleDisplay = ${JSON.stringify(displays[slide - 1])};
            const style = document.createElement('style');
            style.id = 'pocket-render-slide';
            style.textContent = 'html,body{margin:0!important;padding:0!important;width:${viewport.width}px!important;height:${viewport.height}px!important;overflow:hidden!important}section.slide{display:none!important}section.slide[data-pocket-export]{display:' + visibleDisplay + '!important;position:fixed!important;inset:auto!important;left:${left}px!important;top:${top}px!important;width:${size.width}px!important;height:${size.height}px!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;margin:0!important;overflow:hidden!important;box-sizing:border-box!important;transform:scale(${scale})!important;transform-origin:top left!important;scale:1!important}';
            document.head.append(style);
            const slides = Array.from(document.querySelectorAll('section.slide'));
            slides.forEach((item, index) => item.toggleAttribute('data-pocket-export', index === ${slide - 1}));
        })()`);
    }
}

export async function withRender<T>(
    bundle: DesignBundle,
    host: PocketHost,
    signal: AbortSignal | undefined,
    run: (page: DesignPage) => Promise<T>,
): Promise<T> {
    if (active >= 2) {
        throw new Error("2 design renders are already running. Try again when one finishes.");
    }

    const executable = findBrowser();

    if (executable === undefined) {
        throw new Error("Install Chromium or set PI_POCKET_BROWSER to render designs.");
    }

    active++;
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("The design render stopped."));
    const timer = setTimeout(abort, LIMIT_MS);
    let browser: Chromium | undefined;
    let profile: string | undefined;
    let folder: string | undefined;
    let server: Awaited<ReturnType<typeof serveBundle>> | undefined;

    signal?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => browser?.kill(), { once: true });

    try {
        signal?.throwIfAborted();
        folder = await mkdtemp(join(tmpdir(), "pocket-design-"));

        profile = profileFolder(executable, folder);
        server = await serveBundle(bundle);
        browser = await Chromium.launch(executable, profile, [
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ]);
        controller.signal.throwIfAborted();
        const context = await browser.connection.send("Target.createBrowserContext");
        const target = await browser.connection.send("Target.createTarget", {
            url: "about:blank",
            browserContextId: context.browserContextId,
        });
        const attached = await browser.connection.send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
        });
        const page = new DesignPage(
            browser,
            attached.sessionId,
            server.url,
            host,
            controller.signal,
        );

        await page.init();

        return await run(page);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();

        try {
            browser?.kill();
            await browser?.exited;
            await server?.close();

            if (profile !== undefined) {
                await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }

            if (folder !== undefined) {
                await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }
        } finally {
            active--;
        }
    }
}

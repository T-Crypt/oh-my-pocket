/** Agent-facing Design tools and workspace export routes. Registered by the Design module. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { readBundle } from "./bundle.ts";
import { EXPORT_TYPES, type ExportFormat, saveDesignExport } from "./export.ts";
import { VIEWPORTS, viewportOf, withRender } from "./render.ts";
import { designSystemTool } from "./system.ts";

export { designGuide } from "./guide.ts";

const version = Type.Optional(Type.Integer({ minimum: 1 }));
const preset = Type.Union([
    Type.Literal("mobile"),
    Type.Literal("tablet"),
    Type.Literal("desktop"),
]);
const formatSchema = Type.Union([
    Type.Literal("png"),
    Type.Literal("pdf"),
    Type.Literal("pptx"),
    Type.Literal("html"),
]);

export function designTools(host: PocketHost): ToolRegistration[] {
    const preview = Object.assign(
        defineTool({
            name: "design_preview",
            description:
                "Check an HTML design in private headless Chromium pages, never the shared browser. Returns screenshots, console errors, and failed requests. Slide numbers start at 1.",
            parameters: Type.Object({
                id: Type.String(),
                version,
                viewports: Type.Optional(
                    Type.Array(preset, { minItems: 1, maxItems: 3, uniqueItems: true }),
                ),
                fullPage: Type.Optional(Type.Boolean()),
                slide: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            }),
            replay: "safe",
            execute: async (args, api, context) => {
                const bundle = await readBundle(
                    host,
                    api.snapshot,
                    api.conversationId,
                    args.id,
                    args.version,
                    context,
                );
                const views = args.viewports ?? ["mobile", "desktop"];

                return withRender(bundle, host, context.abortSignal, async (page) => {
                    const output: (
                        | { type: "text"; text: string }
                        | { type: "image"; data: string; mimeType: string }
                    )[] = [];

                    for (const view of views) {
                        const size = VIEWPORTS[view];

                        await page.load(size);
                        const slide = args.slide ?? ((await page.isDeck()) ? 1 : undefined);

                        if (slide !== undefined) {
                            await page.showSlide(slide, size);
                        }

                        output.push({
                            type: "text",
                            text: `${args.id} v${bundle.version}: ${view} (${size.width}×${size.height})${slide === undefined ? "" : `, slide ${slide}`}`,
                        });
                        output.push({
                            type: "image",
                            data: await page.screenshot(size, args.fullPage, true),
                            mimeType: "image/png",
                        });
                    }

                    output.push({
                        type: "text",
                        text: JSON.stringify({
                            errors: page.errors,
                            failedRequests: page.failedRequests,
                        }),
                    });

                    return {
                        output,
                        details: {
                            id: args.id,
                            version: bundle.version,
                            viewports: views,
                            errors: page.errors,
                            failedRequests: page.failedRequests,
                        },
                    };
                });
            },
        }),
        { annotations: { readOnlyHint: true } },
    );
    const exportTool = defineTool({
        name: "design_export",
        description:
            "Export an HTML design as PNG, PDF, PPTX (image slides with text notes), or an HTML bundle zip. Writes inside the session folder, by default exports/<id>-v<version>.<ext>. Existing output files are replaced. PPTX requires a deck.",
        parameters: Type.Object({
            id: Type.String(),
            version,
            format: formatSchema,
            viewport: Type.Optional(
                Type.Union([
                    preset,
                    Type.Object({
                        width: Type.Integer({ minimum: 320, maximum: 2560 }),
                        height: Type.Integer({ minimum: 240, maximum: 2560 }),
                    }),
                ]),
            ),
            path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        }),
        execute: async (args, api, context) => {
            const bundle = await readBundle(
                host,
                api.snapshot,
                api.conversationId,
                args.id,
                args.version,
                context,
            );
            const cwd = (await api.agent(context)).cwd;

            if (cwd === undefined) {
                throw new Error("This session has no working directory for the export.");
            }

            const saved = await saveDesignExport(
                bundle,
                {
                    id: args.id,
                    format: args.format,
                    cwd,
                    viewport: args.viewport,
                    path: args.path,
                    signal: context.abortSignal,
                },
                host,
            );

            return {
                output: [
                    {
                        type: "text",
                        text: `Exported ${args.id} v${bundle.version} to ${saved.path}`,
                    },
                ],
                details: {
                    path: saved.path,
                    id: args.id,
                    version: bundle.version,
                    format: args.format,
                    bytes: saved.size,
                },
            };
        },
    });

    return [preview, exportTool, designSystemTool()];
}

/**
 * `POST c/:conversation/export` for the workspace: the same export as `design_export`, written in the session folder at its default
 * path. It answers `{ path, name, size }`; the browser downloads the file through the core file route.
 */
export function designRoutes(web: ExtensionWeb, host: PocketHost): void {
    web.conversationRoute(
        "POST",
        "c/:conversation/export",
        async (request) => {
            const body = request.body;
            const conversation = request.conversation.id;
            const cwd = request.conversation.cwd;

            const id = typeof body.id === "string" ? body.id : "";
            const format = typeof body.format === "string" ? body.format : "";
            const selectedVersion = body.version === undefined ? undefined : Number(body.version);
            const viewport = typeof body.viewport === "string" ? body.viewport : "desktop";

            if (!Object.hasOwn(EXPORT_TYPES, format)) {
                throw web.error(400, "Choose png, pdf, pptx, or html.");
            }

            if (!cwd) {
                throw web.error(400, "This session has no folder for the export.");
            }

            try {
                viewportOf(viewport);
                const bundle = await readBundle(
                    host,
                    request.snapshot,
                    conversation,
                    id,
                    selectedVersion,
                    request.context,
                );
                const saved = await saveDesignExport(
                    bundle,
                    {
                        id,
                        format: format as ExportFormat,
                        cwd,
                        viewport,
                        signal: request.signal,
                    },
                    host,
                );

                return { ...saved, relative: `exports/${saved.name}` };
            } catch (error) {
                if (request.signal.aborted) {
                    throw error;
                }

                throw web.error(
                    400,
                    error instanceof Error ? error.message : "The design export failed.",
                );
            }
        },
        { conversation: "conversation", access: "steer" },
    );
}

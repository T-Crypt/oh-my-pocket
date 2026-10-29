/** Portable bundle, screenshot, print, and image-slide presentation exports. */
import { basename } from "node:path";
import type { PocketHost } from "../host.ts";
import { writeExport } from "./files.ts";
import type { DesignBundle } from "./bundle.ts";
import { pptx } from "./pptx.ts";
import { type DesignViewport, SLIDE_SIZE, viewportOf, withRender } from "./render.ts";
import { zip } from "../zip.ts";

export type ExportFormat = "png" | "pdf" | "pptx" | "html";
export const EXPORT_TYPES = {
    png: { extension: "png", mime: "image/png" },
    pdf: { extension: "pdf", mime: "application/pdf" },
    pptx: {
        extension: "pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    html: { extension: "zip", mime: "application/zip" },
} as const;

export type SaveDesignOptions = {
    id: string;
    format: ExportFormat;
    cwd: string;
    viewport?: string | DesignViewport;
    path?: string;
    signal?: AbortSignal;
};

/** Shared file preparation for the agent tool and JSON workspace route. */
export async function saveDesignExport(
    bundle: DesignBundle,
    options: SaveDesignOptions,
    host: PocketHost,
): Promise<{ path: string; name: string; size: number }> {
    const bytes = await exportDesign(
        bundle,
        options.format,
        options.viewport,
        host,
        options.signal,
    );

    options.signal?.throwIfAborted();
    const target =
        options.path ??
        `exports/${options.id}-v${bundle.version}.${EXPORT_TYPES[options.format].extension}`;
    const path = await writeExport(options.cwd, target, bytes);

    return { path, name: basename(path), size: bytes.length };
}

export async function exportDesign(
    bundle: DesignBundle,
    format: ExportFormat,
    viewport: string | DesignViewport | undefined,
    host: PocketHost,
    signal?: AbortSignal,
): Promise<Buffer> {
    signal?.throwIfAborted();

    if (format === "html") {
        const names = new Set(bundle.assets.map((asset) => asset.name));
        let entry = "index.html";
        let suffix = 0;

        while (names.has(entry)) {
            entry = `pocket-design${suffix === 0 ? "" : `-${suffix}`}.html`;
            suffix++;
        }

        return zip([{ name: entry, bytes: Buffer.from(bundle.content) }, ...bundle.assets]);
    }

    return withRender(bundle, host, signal, async (page) => {
        const size = format === "pptx" ? SLIDE_SIZE : viewportOf(viewport);

        await page.load(size);
        await page.evaluate(`document.title = ${JSON.stringify(bundle.meta.title)}`);

        if (format === "png") {
            const deck = await page.isDeck();

            if (deck) {
                await page.showSlide(1);
            }

            return Buffer.from(
                await page.screenshot(deck ? await page.slideSize() : size, !deck),
                "base64",
            );
        }

        if (format === "pdf") {
            return Buffer.from(await page.pdf(), "base64");
        }

        const texts = await page.slides();
        const slideSize = await page.slideSize();
        const slides: { image: Buffer; text: string }[] = [];
        let total = 0;

        for (const [index, text] of texts.entries()) {
            await page.showSlide(index + 1);
            const image = Buffer.from(await page.screenshot(slideSize), "base64");

            total += image.length;

            if (total > 100_000_000) {
                throw new Error("The presentation images exceed 100 MB.");
            }

            slides.push({ image, text });
        }

        return pptx(slides, slideSize);
    });
}

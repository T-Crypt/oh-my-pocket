/**
 * Read economy: a read without an explicit limit returns at most five hundred lines, so a model that opens a big
 * file gets the part it asked for plus a structural map of the rest (how many lines remain and where the sections
 * sit); to see more it reads on with an offset and a limit. That keeps whole-file dumps out of the context of
 * models that price every token, while the map tells the model what it did not read and how to come back for it.
 * The map is a pure scan of the text the reader fetched; the read-economy extension fetches that text through the
 * environment and appends it to the tool result.
 */

/** How many lines a read without an explicit limit returns. */
export const READ_ECONOMY_LIMIT = 500;
/** How many heading examples the outline shows before it says there are more. */
const OUTLINE_HEADINGS = 8;

/** A line that starts a section: a Markdown heading, a comment banner, or a top-level declaration. */
const HEADING =
    /^(?:#{1,6}\s|\s{0,3}(?:\/\*+|\/\*|\*\/)?\s*(?:export\s+|default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|struct|impl|trait|fn|def)\b|\s{0,3}(?:public|private|protected|static|const|let|var)\s+\w)/;

/**
 * What the read tool's own report says, when the read was not user-limited: the line it stopped at, and, when it
 * reports the total ("Showing lines A-B of C"), the file's total lines.
 */
export function readWindow(text: string): { end: number; total?: number } | undefined {
    const showing = text.match(/lines (\d+)-(\d+) of (\d+)/);

    if (showing !== null) {
        return { end: Number(showing[2]), total: Number(showing[3]) };
    }

    const offset = text.match(/Use offset=(\d+)/);

    if (offset !== null) {
        return { end: Number(offset[1]) - 1 };
    }

    return undefined;
}

/**
 * A structural map of the part of a file a read did not return: `text` holds the lines from `fromLine` to
 * `totalLines` (as the reader returned them), and the map counts them and names the sections that sit in them.
 */
export function outlineRegion(text: string, fromLine: number, totalLines: number): string {
    const lines = text.split("\n");
    const shown: string[] = [];
    let seen = 0;
    let headingCount = 0;

    for (let index = 0; index < lines.length; index++) {
        const lineNo = fromLine + index;

        if (lineNo > totalLines) {
            break;
        }

        seen++;
        const line = lines[index] ?? "";

        if (line.length <= 80 && HEADING.test(line)) {
            headingCount++;

            if (shown.length < OUTLINE_HEADINGS) {
                shown.push(`  L${lineNo}: ${line.trim().slice(0, 60)}`);
            }
        }
    }

    return [
        `[The rest of this file, lines ${fromLine}–${totalLines}: ${seen} lines${headingCount > 0 ? `, ${headingCount} heading${headingCount === 1 ? "" : "s"}, e.g.` : ", no headings found"}`,
        ...shown,
        ...(headingCount > OUTLINE_HEADINGS ? ["  (and more)"] : []),
        `Read any part of it in full with offset: ${fromLine} and a limit.`,
    ].join("\n");
}

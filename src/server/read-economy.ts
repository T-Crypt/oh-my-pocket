/**
 * Read economy: a read without an explicit limit returns at most five hundred lines, so a model that opens a big
 * file gets the part it asked for plus a structural map of the rest (how many lines remain and where the sections
 * sit); to see more it reads on with an offset and a limit. That keeps whole-file dumps out of the context of
 * models that price every token, while the map tells the model what it did not read and how to come back for it.
 * The map starts where the read really stopped - the tool's own report of its line and byte caps, not the limit
 * the wrapper injected - and the map itself is bounded: it scans at most a few thousand tail lines and decodes at
 * most a megabyte of their bytes, saying when its budget stops short of the file's end. The read-economy
 * extension fetches that text through the environment and appends the map to the tool result.
 */

/** How many lines a read without an explicit limit returns. */
export const READ_ECONOMY_LIMIT = 500;
/** How many lines of the unread tail the map scans. */
export const OUTLINE_LINE_BUDGET = 2000;
/** How many bytes of the unread tail the map reads and decodes. */
export const OUTLINE_BYTE_BUDGET = 1_000_000;
/** How many heading examples the outline shows before it says there are more. */
const OUTLINE_HEADINGS = 8;

/** A line that starts a section: a Markdown heading, a comment banner, or a top-level declaration. */
const HEADING =
    /^(?:#{1,6}\s|\s{0,3}(?:\/\*+|\/\*|\*\/)?\s*(?:export\s+|default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|struct|impl|trait|fn|def)\b|\s{0,3}(?:public|private|protected|static|const|let|var)\s+\w)/;

/**
 * What the read tool's own report says: the last line the read showed, and, when the report carries it, the
 * file's total lines. A read that hit neither the tool's line cap nor its byte cap reported nothing, and a
 * first line too big for the byte cap reports no line to continue from - both are `undefined` here.
 */
export function readWindow(text: string): { end: number; total?: number } | undefined {
    const showing = text.match(/lines (\d+)-(\d+) of (\d+)/);

    if (showing !== null) {
        return { end: Number(showing[2]), total: Number(showing[3]) };
    }

    const more = text.match(/(\d+) more lines in file\. Use offset=(\d+)/);

    if (more !== null) {
        const end = Number(more[2]) - 1;

        return { end, total: end + Number(more[1]) };
    }

    const offset = text.match(/Use offset=(\d+)/);

    if (offset !== null) {
        return { end: Number(offset[1]) - 1 };
    }

    return undefined;
}

/**
 * A structural map of the part of a file a read did not return: `text` holds the lines from `fromLine` to
 * `coveredTo` (as the reader returned them), and `totalLines` is the file's last line as the tool's report
 * counts it. When the map's budget stopped short of `totalLines`, the map says where it stops and how many
 * lines run on past it.
 */
export function outlineRegion(
    text: string,
    fromLine: number,
    totalLines: number,
    coveredTo: number,
): string {
    const lines = text.split("\n");
    const shown: string[] = [];
    let seen = 0;
    let headingCount = 0;

    for (let index = 0; index < lines.length; index++) {
        const lineNo = fromLine + index;

        if (lineNo > totalLines || lineNo > coveredTo) {
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

    const headings =
        headingCount > 0
            ? `, ${headingCount} heading${headingCount === 1 ? "" : "s"}, e.g.`
            : ", no headings found";
    const body = [...shown, ...(headingCount > OUTLINE_HEADINGS ? ["  (and more)"] : [])];
    const head =
        coveredTo >= totalLines
            ? `[The rest of this file, lines ${fromLine}–${totalLines}: ${seen} lines${headings}`
            : `[The rest of this file, lines ${fromLine}–${totalLines}: ${seen} of ${
                  totalLines - fromLine + 1
              } lines are mapped, but the outline's budget stops at line ${coveredTo} and ${
                  totalLines - coveredTo
              } lines run on past it${headings}`;

    return [
        head,
        ...body,
        `Read any part of it in full with offset: ${fromLine} and a limit.`,
    ].join("\n");
}

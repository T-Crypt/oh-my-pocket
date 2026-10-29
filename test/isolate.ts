// The isolated Pi install and folders the tests share. `helpers.ts` imports this first, before anything from src/
// loads: a static import of the app after it (not a dynamic one) is what Node 26 orders correctly when a test also
// imports src/ modules that import the app.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
// Every tool offered, as the tests were written; lean-prompt.test.ts turns the lean prompt on for itself.
process.env.PI_POCKET_LEAN_PROMPT ??= "0";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);
/** The home folder the app finds `~/.agents/skills` in, for the same isolation. */
export const home = join(root, "home");
mkdirSync(home);

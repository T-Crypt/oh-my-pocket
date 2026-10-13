// The gate for web/. web/ is not clean, so its findings are reported but do not fail the run.
// Only the files listed in web-clean.txt are held to being clean, and that list can only grow by
// annotating a file.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const clean = readFileSync(new URL("web-clean.txt", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);
const tsc = "node_modules/typescript/bin/tsc";
const run = spawnSync("node", [tsc, "--noEmit", "-p", "tsconfig.web.json"], { encoding: "utf8" });
const findings = (run.stdout + run.stderr).trim();

if (findings) {
    console.log(findings);
}

const broken = findings.split("\n").filter((line) => clean.some((path) => line.startsWith(path)));

if (broken.length) {
    console.log(`\nthe gate holds these clean:\n${broken.join("\n")}`);
    process.exit(1);
}

if (run.status !== 0 && run.status !== 2) {
    process.exit(1);
}

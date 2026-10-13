// The gate for web/. web/ is not clean, so its findings are reported but do not fail the run.
// Only the files listed in web-clean.txt are held to being clean, and that list can only grow by
// annotating a file.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const clean = readFileSync(new URL("web-clean.txt", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const tsc = "node_modules/typescript/bin/tsc";
const run = spawnSync("node", [tsc, "--noEmit", "-p", "tsconfig.web.json"], {
    encoding: "utf8",
    // Fits the whole list, 328 KB today: spawnSync's own 1 MiB truncates the output and reports no status.
    maxBuffer: 64 * 1024 * 1024,
});
const findings = (run.stdout + run.stderr).trim();
const reported = findings.split("\n");

if (findings) {
    console.log(findings);
}

const broken = reported.filter((line) => clean.some((path) => line.startsWith(path)));
// A configuration error exits 2 as well and names the config, not a file under web/, so error lines that are not
// all on web/ mean the run read no config it could check. `process.exitCode`, not `exit`: an exit drops the pipe.
const config = reported.filter((line) => line.includes("error TS") && !line.startsWith("web/"));

if (broken.length) {
    console.log(`\nthe gate holds these clean:\n${broken.join("\n")}`);
}

if (broken.length || config.length || (run.status !== 0 && run.status !== 2)) {
    process.exitCode = 1;
}

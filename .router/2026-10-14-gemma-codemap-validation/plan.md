# Plan: validate 7 Oh-My-Pocket improvements (gemma-codemap run, 2026-10-14)

## Goal (one sentence)

Validate all 7 proposed improvements with SEEN / TESTED / VALIDATED / PROVEN evidence on throwaway copies before any global change to Pi Pocket, llama-swap config, indexes, or skills.

## Evidence ladder (used by every step)

- **SEEN:** file read and quoted (path + line); no behavior executed.
- **TESTED:** exercised on a copy or with a read-only command; output captured.
- **VALIDATED:** check command passes on the copy (e.g. `npm run check`, `node --test`, copy-server log clean, side-by-side comparison numbers).
- **PROVEN:** validated on the copy **plus** undo path shown (what file to restore, what command reverses it) and no live-data / restart / secret exposure involved.

No step may touch live data (`~/.pi-pocket/` in place), restart the production server, touch VM 250 / 10.0.0.184, or print a secret value (refer to secret PATHs only).

## Files to change and how (all validation-only; production edits come later)

All work happens in this run folder plus throwaway copies. Expected production targets (NOT edited in this plan):

1. **embed2 cutover** — prod target: `~/homelab/reference/llama-swap/config.yaml` (`embeddinggemma-2`/`embed2` entry + `embeddings` group) and `~/homelab/scripts/codevec_mcp.py` (`CODEVEC_EMBED_URL`, `index_repo` default model). Validation only reads them and queries both endpoints read-only.
2. **Index coverage** — prod target: codevec SQLite index (default `~/.config/opencode/codevec/index.db`). Validation only: `list_repos` + `search_code` reads; any reindex goes to a **copy** of the DB (`CODEVEC_DB=/tmp/...`), never the live DB.
3. **Batteries (loop-guard / pruner / read-economy / tool-repair)** — prod target: `~/.pi-pocket/config.json` `enabledExtensions` (currently missing the four; built-ins exist in `src/server/extensions/` and `ORDER` in `src/server/reload.ts`). Validation only: enable them on a `node test/serve.ts` copy with its own temp data dir, never the live `config.json`.
4. **muse-router fast path** — prod target: `~/.pi-pocket/routers/muse-router.json` (+ `ROUTER-FAST.md` pattern) and/or a new `muse-router-fast.json`. Validation only: read the JSON, draft candidate in run folder, dry-run stage dispatch on the copy.
5. **Per-role skills for cloud** — prod target: `~/.pi-pocket/hq/skills.json` (rendered by `~/homelab/scripts/agents/apply_roles.py` from `roles.yaml`) + `~/.pi-pocket/extensions/hq-router.ts` skill-trim section. Validation only: read `skills.json` keys, test skill-trim prompt rendering on the copy with a cloud model id; no edit to live `skills.json`.
6. **Typed handoffs** — prod target: router prompt convention (`<run>/handoff.md`: goal, paths, file:line) in `ROUTER*.md`, possibly a schema/template file. Validation only: write a sample typed `handoff.md` + schema in run folder, have a stage-shaped read test consume it on the copy.
7. **Gemma4 decision** — prod target: `~/homelab/reference/llama-swap/config.yaml` (`Gemma4-26B-A4B-QAT` entry, chat-group member) and router model picks (`ROUTER.md`, `~/.pi-pocket/routers/`). Validation only: read-only load/smoke evidence already in config comments + read-only probe; no config edit, no model load initiated by this plan (GPU is shared).

Run-folder outputs (the only files this plan writes):

- `.router/2026-10-14-gemma-codemap-validation/plan.md` (this file)
- `.router/2026-10-14-gemma-codemap-validation/evidence.md` (per-improvement SEEN/TESTED/VALIDATED/PROVEN log)
- `.router/2026-10-14-gemma-codemap-validation/<probe outputs, candidate json, sample handoff>`

## Steps in order (each with its proof command)

### 0. Baseline reads (SEEN for all 7)

- Read `src/server/reload.ts` lines 29–85 (ORDER/TITLES/OFF_BY_DEFAULT — batteries are built-in, opt-in via Extensions sheet). SEEN when quoted.
- Read `src/server/extensions/loop-guard.ts`, `pruner.ts`, `read-economy.ts`, `tool-repair.ts` headers (first ~30 lines each). SEEN when quoted.
- Read live `~/.pi-pocket/config.json` `enabledExtensions` (redact `ownerToken`, hashes — never paste values). SEEN = list of enabled vs missing four.
- Read `~/homelab/reference/llama-swap/config.yaml` Gemma4 block (~lines 450–483), embed2 block (~657–678), routing groups (~684–718). SEEN when quoted.
- Read `~/.pi-pocket/routers/muse-router.json` (full, ~60 lines) and `~/.pi-pocket/hq/skills.json` keys + one role list. SEEN when quoted.
- Read `~/.pi-pocket/extensions/hq-router.ts` header (~first 60 lines: skill-trim + fast-profile block) and `~/.pi-pocket/hq/ROUTER-FAST.md` handoff sections. SEEN when quoted.

Proof commands (read-only, no secrets printed):

```sh
sed -n 29,85p src/server/reload.ts
head -n 30 src/server/extensions/loop-guard.ts src/server/extensions/pruner.ts src/server/extensions/read-economy.ts src/server/extensions/tool-repair.ts
python3 -c "import json; d=json.load(open('/home/tcrypt/.pi-pocket/config.json')); print(d['enabledExtensions'])"
grep -n "Gemma4\|embed2\|embeddinggemma\|embeddings" /home/tcrypt/homelab/reference/llama-swap/config.yaml
python3 -c "import json; print(json.load(open('/home/tcrypt/.pi-pocket/routers/muse-router.json'))['pipeline'][0])"
python3 -c "import json; d=json.load(open('/home/tcrypt/.pi-pocket/hq/skills.json')); print(sorted(d.keys()))"
```

### 1. embed2 cutover validation (read-only, no reindex of live DB)

1. Confirm both embedding entries coexist: `embed` → nomic (2048 ctx, CPU), `embed2` → embeddinggemma-2 (8192 ctx, CPU), both in `embeddings` group (persistent, non-exclusive). SEEN via step 0.
2. Probe both endpoints read-only (dimensionality + a fixed query string; record dims: nomic 768d expected, gemma 768d with MRL note in config comment — codevec comment says "same 768d" for nomic; verify gemma dim from response, do NOT assume).
3. Compare retrieval quality on 3–5 fixed natural-language queries against the `oh-my-pocket` repo via `search_code` with each embedder (whichever the MCP currently points at; note which). Record top-k paths per query in `evidence.md`. TESTED when both result sets are captured.
4. UNCLEAR (say so in evidence.md): whether existing nomic vectors stay comparable under gemma (config comment says trial alongside, `embed` untouched so existing vectors compare; codevec_mcp.py comment line ~41 says existing nomic vectors must be re-indexed). Do NOT reindex live. VALIDATED only when a **copy** DB reindex under gemma completes and the same queries return sane hits.
5. Cutover recommendation + undo: keep `embed` alias until copy-DB test passes; undo = delete `embeddinggemma-2` entry + its group member line (as the config comment states). PROVEN requires steps 2–4 plus undo line verified by `git diff --stat` showing only the two config hunks would change (do not apply).

Proof commands:

```sh
grep -n -A8 '"embeddinggemma-2"\|"text-embedding-nomic' /home/tcrypt/homelab/reference/llama-swap/config.yaml
sed -n 1,60p /home/tcrypt/homelab/scripts/codevec_mcp.py
# read-only probes via MCP search_code / list_repos (no live reindex):
# search_code({repo:'oh-my-pocket', query:'<fixed query>', k:5}) x3-5, recorded per embedder
```

### 2. Index coverage validation (read-only + copy-DB only)

1. `list_repos` → record indexed repos, chunk counts, last-indexed times. TESTED when output is saved to run folder.
2. `get_file_map` for `oh-my-pocket` → compare file list against `git ls-files | wc -l` for staleness estimate. TESTED.
3. 3 fixed `search_code` queries (e.g. "loop guard identical tool call block", "read economy truncation map", "router stage prompt") → record hit/miss. A miss = coverage gap, not a code bug.
4. If a gap: `index_repo` ONLY against a copy (`CODEVEC_DB=/tmp/codevec-copy.db`), then re-run the 3 queries. VALIDATED when copy-index queries hit. Never run `index_repo` against the live DB from this plan.

Proof commands:

```sh
# via codebase MCP: list_repos, get_file_map({repo:'oh-my-pocket'})
git ls-files | wc -l
CODEVEC_DB=/tmp/codevec-copy.db python3 /home/tcrypt/homelab/scripts/codevec_mcp.py --help 2>&1 | head -n 20
```

### 3. Batteries validation (copy server only)

1. Start copy: `nohup node test/serve.ts > /tmp/pocket-copy-batteries.log 2>&1 & sleep 5; cat /tmp/pocket-copy-batteries.log`. TESTED when sign-in links print and log shows no errors.
2. In the copy (via its sign-in link / API, never live): turn on `read-economy.ts`, `loop-guard.ts`, `pruner.ts`, `tool-repair.ts` in the Extensions sheet; confirm reload notices, no errors in copy log.
3. Exercise each on the copy:
   - read-economy: read a >500-line file without limit → expect ≤500 lines + structural map of remainder.
   - tool-repair: submit a slightly malformed tool call (object-as-JSON-string) via codemode on the copy → expect repaired, not a validation failure.
   - loop-guard: three exactly identical failing calls in one turn on the copy → expect third blocked with "says so" message.
   - pruner: compaction-shaped input (or existing pruner test) → expect masked tool output note before any model summary.
4. Run the related unit tests (they do not need the copy): TESTED → VALIDATED when green.

Proof commands:

```sh
nohup node test/serve.ts > /tmp/pocket-copy-batteries.log 2>&1 & sleep 5; cat /tmp/pocket-copy-batteries.log
node --test test/app.test.ts 2>&1 | tail -n 20
grep -rln "loop-guard\|read-economy\|pruner\|tool-repair" test/ 2>&1
# stop copy with the kill <id> it printed (also deletes its data); never kill -9
```

VALIDATED = steps 2–4 all pass on the copy with log excerpts in `evidence.md`. PROVEN = plus the production undo stated (turn off in Menu → Extensions; no file change needed since built-ins stay in `ORDER`).

### 4. muse-router fast path validation

1. SEEN: quote `muse-router.json` pipeline (plan → implement → review → fix → ship) and `ROUTER-FAST.md` dispatcher rule (bash/edit/write blocked, width 1, out-of-scope → `handoff.md`).
2. Draft `muse-router-fast.json` candidate IN THE RUN FOLDER ONLY (not `~/.pi-pocket/routers/`): same pipeline with fast model (`agent-fast`/`router-fast`), dispatcher tool block, width-1 note, handoff-on-escape step. TESTED when the JSON parses.
3. Dry-run on the copy server: register the candidate as a test router (copy data dir only) or simulate stage dispatch (plan-stage prompt render) and confirm dispatcher block triggers on an edit attempt. VALIDATED when copy log / test output shows the block + `handoff.md` path suggested.
4. UNCLEAR to state in evidence.md: whether `hq-router.ts` tool-blocking is per-conversation and applies to a new router id without code change (header says "per conversation, so its stages keep their tools" for `router-fast`; verify the id-matching logic before claiming the fast path works for a new id).

Proof commands:

```sh
python3 -c "import json; json.load(open('.router/2026-10-14-gemma-codemap-validation/muse-router-fast.json')); print('json ok')"
grep -n "router-fast\|blocked\|per conversation\|Width" /home/tcrypt/.pi-pocket/hq/ROUTER-FAST.md | head -n 20
grep -n "router-fast\|routerFast\|blocked\|prepareArguments\|beforeTool" /home/tcrypt/.pi-pocket/extensions/hq-router.ts | head -n 30
```

### 5. Per-role skills for cloud validation

1. SEEN: `skills.json` role keys (`router, plan, coder, agent, review, writer, thinker, uncensored, agent-fast, coder-fast`), one full role list, and the `hq-router.ts` skill-trim paragraph (102 skills ~6.8K tokens → session's own list; `/skill:<name>` still loads any).
2. On the copy server: open a session whose model id is a cloud model (or the closest available non-`router*` id) with a role marker (`<!-- hq-role: coder -->` style) and confirm the prompt carries only that role's skills while `/skill:<other>` still resolves. TESTED when copy prompt/log excerpts are saved.
3. Measure token delta (full catalog vs trimmed) from the copy's rendered prompt if exposed; otherwise record "not exposed on copy, estimate from code". VALIDATED when trimmed list == `skills.json[role]` exactly (diff command output saved).
4. UNCLEAR to state: which file renders cloud-role prompts (`apply_roles.py` + `roles.yaml` live in `~/homelab/harnesses/agents/` — confirm path before recommending an edit).

Proof commands:

```sh
python3 -c "import json; d=json.load(open('/home/tcrypt/.pi-pocket/hq/skills.json')); print({k: len(v) for k,v in d.items()})"
grep -n "skills.json\|hq-role\|skill" /home/tcrypt/.pi-pocket/extensions/hq-router.ts | head -n 30
ls /home/tcrypt/homelab/harnesses/agents/roles/ 2>&1 | head; ls /home/tcrypt/homelab/scripts/agents/ 2>&1 | head
```

### 6. Typed handoffs validation

1. SEEN: quote the `handoff.md` convention (goal, paths, file:line, what-is-known) from `ROUTER-FAST.md` lines ~105–115 and ~240/315.
2. Write `handoff.schema.json` (fields: goal, project, worktree, instructionFiles, findings[{file, line, claim}], nextSteps, outOfScope) + a sample `handoff.sample.md` IN THE RUN FOLDER. TESTED when a JSON validation of the sample passes.
3. Consumption test on the copy: point a plan-shaped stage at the sample handoff path (paths-not-contents rule) and confirm it can proceed without the parent context. VALIDATED when the stage output references the handoff's file:line claims.
4. Recommendation states the production home options WITHOUT editing: (a) convention-only (prompt text), (b) template file beside `ROUTER*.md`, (c) enforced schema in `hq-router.ts`. Name the open choice in evidence.md.

Proof commands:

```sh
sed -n 100,120p /home/tcrypt/.pi-pocket/hq/ROUTER-FAST.md
python3 -c "import json; s=json.load(open('.router/2026-10-14-gemma-codemap-validation/handoff.schema.json')); h=json.load(open('.router/2026-10-14-gemma-codemap-validation/handoff.sample.json')); print('schema+sample ok')"
```

### 7. Gemma4 decision validation (read-only; no model load by this plan)

1. SEEN: quote the Gemma4 block (artifact hash/size, BF16-KV-only, no prefix reuse, top_k ≤ 20, vision not wired, MTP full-head-only, undo = delete entry + 2 env vars + restart).
2. Record the measurements already in the config comment (aphotic 2026-10-13: load 34 s, 17,454 MiB at 131072, tool_calls with correct args) as TESTED-by-prior-run, NOT re-proven here; note VRAM headroom vs the 22,900 MiB budget and the chat-group exclusivity (one chat model at a time).
3. Read-only currency check: `git -C ~/homelab log --oneline -5 -- reference/llama-swap/config.yaml` + confirm the `Gemma4-26B-A4B-QAT` chat-group member line and `gemma4-26b` alias are present. TESTED when outputs are saved.
4. Decision matrix in evidence.md (no global change): (a) adopt as router/NInfer role — needs prefix-reuse + vision gaps closed; (b) keep as opt-in alias for text/tool trials on the copy; (c) defer. PROVEN requires a copy-server session on the gemma id with a scripted multi-turn + tool-call transcript — explicitly OUT OF SCOPE for the plan stage; state it as the implement stage's first step, and do NOT load/evict models here (one-GPU box, shared with the operator).

Proof commands:

```sh
git -C /home/tcrypt/homelab log --oneline -5 -- reference/llama-swap/config.yaml
grep -n "Gemma4" /home/tcrypt/homelab/reference/llama-swap/config.yaml
```

### 8. Close-out

1. Write `evidence.md` with one section per improvement: rating (SEEN/TESTED/VALIDATED/PROVEN), quotes/outputs, and UNCLEAR items.
2. Run `git -C /home/tcrypt/projects/oh-my-pocket status --short` to prove no file outside the run folder changed.
3. Stop any copy servers with the `kill <id>` from their logs (deletes temp data).

Proof commands:

```sh
git -C /home/tcrypt/projects/oh-my-pocket status --short
ls -la .router/2026-10-14-gemma-codemap-validation/
```

## Risks

- **Live-data contamination:** mitigated by `test/serve.ts` temp data dirs + `CODEVEC_DB=/tmp/...` copies only; never open the live `PI_POCKET_DIR`, never edit `~/.pi-pocket/config.json` or `skills.json` in place.
- **Server restart / blank app:** no `web/**` or `src/server/**` edits in this plan; no restart requested or performed; copy listens on `127.0.0.2:8899` so cookies for the real server are untouched.
- **GPU eviction / operator disruption:** no model loads, no `lsw.py apply`, no `berth run`; Gemma4 evidence is read from config comments + git log, not a fresh load.
- **Secret leak:** `config.json` contains `ownerToken`/hashes — quote only key names and `enabledExtensions`; refer to secret PATHs, never values.
- **VM 250 / 10.0.0.184:** no network or Proxmox action of any kind in this plan.
- **Scope creep into global change:** each improvement's production edit is named but explicitly deferred; the implement stage must refuse to apply them until every item reaches at least TESTED and batteries/fast-path reach VALIDATED on the copy.
- **Stale index conclusions:** retrieval comparisons are only as good as index freshness — record `list_repos` timestamps alongside every query result; a "miss" with a stale timestamp is a coverage finding, not a model finding.
- **Unclear items (must appear in evidence.md, not guessed):** gemma vector comparability + reindex requirement; `hq-router.ts` id-matching for a new fast router id; cloud role-prompt renderer path (`apply_roles.py`/`roles.yaml` location); typed-handoff enforcement home; Gemma4 copy-server trial deferred to implement.

## Key paths (reference only)

- Pocket repo: `/home/tcrypt/projects/oh-my-pocket/` — `src/server/extensions/{loop-guard,pruner,read-economy,tool-repair}.ts`, `src/server/reload.ts` (ORDER), `test/serve.ts`, `docs/self-editing.md`, `docs/map.md`
- Live data (read-only here): `/home/tcrypt/.pi-pocket/config.json`, `/home/tcrypt/.pi-pocket/routers/muse-router.json`, `/home/tcrypt/.pi-pocket/hq/{ROUTER*.md,skills.json,mcp-tools.json}`, `/home/tcrypt/.pi-pocket/extensions/hq-router.ts`
- Lab (read-only here): `/home/tcrypt/homelab/reference/llama-swap/config.yaml`, `/home/tcrypt/homelab/scripts/codevec_mcp.py`, roles source under `/home/tcrypt/homelab/harnesses/agents/`
- This run: `/home/tcrypt/projects/oh-my-pocket/.router/2026-10-14-gemma-codemap-validation/`

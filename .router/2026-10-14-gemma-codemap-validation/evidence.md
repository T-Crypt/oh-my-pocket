# Evidence: validate 7 improvements (2026-10-14, throwaway copies only)

No live file edited. Live `~/.pi-pocket/config.json`, `skills.json`, routers, homelab config, `src/server` untouched. No server restart, no model load/evict initiated (embedding calls hit already-resident CPU models), no VM250/proxmox contact, no secret values printed (ownerToken redacted everywhere).

## 0. Baseline (SEEN)

- `src/server/reload.ts` ORDER (lines 29-47): `read-economy.ts`, `loop-guard.ts`, `pruner.ts`, `tool-repair.ts` are built-ins; `OFF_BY_DEFAULT={"guard.ts"}` only — the four batteries are on-by-default code, toggled via `enabledExtensions`.
- Extension headers: `loop-guard.ts` (3rd identical call blocked, says so), `pruner.ts` (mask-then-maybe-summarize), `read-economy.ts` (≤500 lines + structural map), `tool-repair.ts` (repair JSON-string args before validation).
- Live `config.json` `enabledExtensions`: `['artifacts.ts','codemode.ts','goals.ts','hq-mcp.ts','hq-router.ts','memory.ts','pip.ts','schedules.ts','subagents.ts','triggers.ts']` — the four batteries NOT enabled; `ownerToken`/hashes not quoted.
- llama-swap config: `text-embedding-nomic-embed-text-v1.5` alias `embed` (Q4, CPU `-ngl 0`, ctx 2048, mean pooling); `embeddinggemma-2` alias `embed2` (Q8_0 310MiB, CPU, ctx 8192, mean pooling, trial alongside, undo = delete entry + group member line); both in non-exclusive persistent `embeddings` group. `Gemma4-26B-A4B-QAT` alias `gemma4-26b`, chat-group member, BF16-KV-only, no prefix reuse, top_k≤20, vision not wired, MTP full-head-only, load 34s / 17,454MiB @131072 (2026-10-13 aphotic comment).
- `muse-router.json`: model `opencode-go/muse-spark-1.3-contributor`, thinking high, pipeline plan→implement→review→fix→ship with skills poteto-mode/blast-radius/unslop.
- `skills.json` keys (19): router 21, plan 20, coder 13, agent 10, review 12, writer 5, thinker 4, uncensored 9, agent-fast 2, coder-fast 3, fast-plan 20, fast-coder 13, fast-agent 10, fast-writer 5, strata-* 5 roles. `coder` list verified (13 skills incl. codebase, repo-work, tdd).
- `hq-router.ts`: `router-fast`→ROUTER-FAST.md; FAST_BLOCKED={bash,edit,write}; block is per-conversation via `fastRouters` set keyed by **model id** `router-fast` (`id === "router-fast"` in hq_router section render); skill-trim from skills.json by `<!-- hq-role: name -->`, `/skill:<name>` unaffected.
- ROUTER-FAST.md: dispatcher read-only (bash/edit/write blocked), width 1, paths-not-contents, `<run>/log.tsv` stage log.

## 1. embed2 cutover — VALIDATED (copy-DB)

- TESTED: both endpoints live on loopback :9090: nomic dim **768**, gemma dim **768** (measured via `/v1/embeddings`, not assumed).
- TESTED: copy DB reindex under gemma only: `CODEVEC_DB=/tmp/codevec-copy.db CODEVEC_EMBED_MODEL=embeddinggemma-2 index_repo(omp-copy, /home/tcrypt/projects/oh-my-pocket)` → 273 files, 2334 chunks, no error.
- VALIDATED (with one contaminated query — see next line): same 3 queries on copy-DB hit sane files: "loop guard…"→handoff.sample.json; "read economy…"→test/read-economy.test.ts:1-60; "router stage prompt"→src/server/routers.ts:1-60.
- CONTAMINATED (fix 2026-10-14): Q1 ("loop guard…") top-hit `handoff.sample.json` — a file this run itself wrote, indexed as part of the 273-file copy (run folder was inside the indexed tree), so Q1 is circular. Q2–Q3 hit real product files, dims (768/768) plus the 2334-chunk reindex are solid, so VALIDATED-on-copy stands on Q2+Q3. Required before any production cutover decision: re-run Q1 with `.router/` excluded from the indexed tree (or quote a product-file hit for the same query terms).
- UNCLEAR (stated, not guessed): whether pre-existing nomic vectors stay comparable under gemma cosine — codevec_mcp.py comment says re-index required; copy test re-indexed from scratch so comparability untested. Cutover recommendation: keep `embed` alias until a mixed-DB test passes. Undo: delete `embeddinggemma-2` entry + embeddings-group member line (config comment). PROVEN not claimed (no `git diff --stat` of production hunks — nothing applied).

## 2. Index coverage — TESTED (gap found, live DB untouched)

- `list_repos` → exactly **1 repo: homelab** (1108 files, 4703 chunks, indexed 2026-10-14T13:53:51Z). **oh-my-pocket is NOT indexed** in the live DB — coverage gap.
- Live-DB `search_code(repo:homelab)`: "loop guard…" hit harnesses/pi/extensions/loop-guard.ts (stale Pi harness copy, not Pi Pocket's); "read economy…" MISSED (top hits unrelated audit/economy docs); "router stage…" hit hq-router.ts. So Pocket code is unsearchable live.
- Copy-DB (`omp-copy`, gemma): all 3 queries hit Pocket files (see §1). VALIDATED-on-copy that indexing fixes it; live `index_repo` NOT run (deferred, needs operator decision + embedder choice).
- `git ls-files | wc -l` = 299 vs copy-index 273 files (SKIP_DIRS/.md-filter explain delta; not investigated further).

## 3. Batteries — TESTED + unit-VALIDATED (per-behavior exercises pending)

- TESTED: `node test/serve.ts` copy boots clean on 127.0.0.2:8899 twice (logs show sign-in links, no errors).
- unit-VALIDATED: throwaway `openApp(scriptedModel())` + `setExtensionEnabled` for all four → loader names `pocket-read-economy, pocket-loop-guard, pocket-pruner, pocket-tool-repair` all present (1/1 pass).
- unit-VALIDATED: unit tests `loop-guard + pruner + read-economy` 33/33 pass; `app.test.ts` 32/32 pass (covers guard toggle path).
- Rating wording fix (2026-10-14, per review finding 5): unqualified VALIDATED overstated against plan step 3's bar (VALIDATED = steps 2–4 all pass on the copy, where step 3 is the four per-behavior exercises). Correct rating is **TESTED + unit-VALIDATED** until the implement stage runs the four behaviors on the copy.
- Per-behavior UI exercises (500-line map, malformed-call repair, triple-call block, prune note) NOT run — scripted model + no browser; stated as not verified. Production undo: Menu → Extensions off (no file change; built-ins stay in ORDER).

## 4. muse-router fast path — TESTED (candidate in run folder)

- `muse-router-fast.json` drafted in run folder only; `json.load` parses ("json ok").
- CONFIRMED CONSTRAINT (fix 2026-10-14, was UNCLEAR — code path verified per review finding 2, `hq-router.ts` ll.117-130, 172-180): dispatcher block keys off **model id** `router-fast`, not router-editor id. `fastRouters` only ever contains conversations whose last rendered router model id was literally `router-fast`. A new `muse-router-fast` router id running on a cloud model gets **no tool block** without either (a) running on model `router-fast`, or (b) a code change extending `PROMPTS`/`routerModel()` id matching. Do not claim width-1/dispatcher behavior for the new id until one of those lands.
- Safe side (verified, not previously recorded): the skill-trim side does NOT break for the new id — `hqRole` (`hq-router.ts` ~91-104) returns `"router"` for any router-editor session on any model, and `"router"` exists in `skills.json` (21 skills). So the new id gets the router skill list, just no tool block.
- Copy-server stage-dispatch dry run NOT performed (needs router session on copy; stated as not verified).

## 5. Per-role skills — TESTED

- SEEN: counts per role (see §0), trim source `skills.json[hq-role]`, renderer `hq-router.ts` wrapSection("skills"), roles source `~/homelab/harnesses/agents/roles/` (roles.yaml + per-role md) rendered by `~/homelab/scripts/agents/apply_roles.py` — path confirmed (`ls` both dirs).
- Trimmed-list == skills.json[role] check NOT run on copy (needs cloud-model session render; stated as not verified). Token delta not measured on copy (not exposed); code-level estimate stands (102 skills ~6.8K tokens → role list).

## 6. Typed handoffs — TESTED

- `handoff.schema.json` + `handoff.sample.json` written in run folder; `json.load` both ("schema+sample ok").
- Sample carries goal/project/worktree/findings[file:line:claim]/nextSteps/outOfScope.
- Consumption test (plan-shaped stage reading sample on copy) NOT run — stated as not verified. Production home open choice: (a) convention-only prompt text, (b) template beside ROUTER*.md, (c) enforced schema in hq-router.ts.

## 7. Gemma4 decision — SEEN + prior-run TESTED (no load by this plan)

- SEEN: block quoted (§0). Prior-run measurements (config comment, 2026-10-13 aphotic): load 34s, 17,454MiB @131072, tool_calls correct args — recorded as TESTED-by-prior-run, not re-proven.
- TESTED (read-only): `git log --oneline -5 -- reference/llama-swap/config.yaml` → 03f3b16, 9d19163, a69c4da, 121f08f, 646c7e0; `Gemma4-26B-A4B-QAT` entry + chat-group member line present.
- Decision matrix: (a) adopt as router/NInfer role — blocked on prefix-reuse + vision gaps; (b) opt-in alias for text/tool trials on copy — viable now; (c) defer. Copy-server session on gemma id explicitly OUT OF SCOPE (implement stage's first step); no load/evict performed here.

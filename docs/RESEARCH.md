# Research: harness features worth porting into Oh-My-Pocket

Written 2026-10-11. This is a survey of what other agent harnesses do well, and a ranked list of
what is worth taking into Oh-My-Pocket. It is a claim about those projects, not about this one:
where a number is not measured on our own stack it is labelled as such.

Method: read the harnesses' own docs and repos, the [best-of-Agent-Harnesses](https://github.com/RyanAlberts/best-of-Agent-Harnesses)
index and its decision guides, the two primary papers behind the "observation masking" and
"diff format" claims, and the prior internal notes in `~/handoffs/oh-my-pocket/2026-10-11-dsh-review/`
(`research.md`, `research-big.md`). Nothing here is measured on our stack yet; each recommendation
names the A/B that would decide it.

## How to read this

**Evidence tiers**, marked on every claim:

| Tier | Means |
|---|---|
| **measured** | A number from a named benchmark or run, with the harness/model named. |
| **vendor** | The project's own claim. Directional, not independent. |
| **unverified** | Design reasoning only, no number. |

**The harness is a pairing, not a winner.** Harness-Bench measured a rank correlation of about
**-0.05** between harness rankings on different models: the best harness for one model says almost
nothing about another, and the best harness for a small local Qwen is not the best for Opus.
So every recommendation below is "A/B it on NInfer", never "it wins elsewhere".

**How to A/B here.** Run the same task in OMP and in Oh-My-Pocket against the same llama-swap
server, then read `/api/metrics/activity` (paged, newest first) for prompt tokens, cache hits,
output, and wall time. A battery stays only if it holds or improves those numbers without lowering
the result. The built-in context meter (`/context`, or a tap on the status-line meter) is where a
change to a prompt section, a tool schema, or a skill list is read as a diff of its own row.

---

## 1. The landscape

Stars captured 2026-10-11 from the best-of-Agent-Harnesses index (a curated list of 166 projects).
The rows are the ones that matter to a local-model harness: Pi and its forks, the terminal agents,
the always-on runtimes, and the two harnesses whose design facts we already borrow from.

| Harness | Stars | License | Autonomy | Recovery | What people value it for |
|---|---|---|---|---|---|
| [opencode](https://github.com/anomalyco/opencode) | 213k | MIT | headless | resumable | Biggest community; 75+ providers, local included; client/server split. Replaced our CT 303. |
| [Codex](https://github.com/openai/codex) | 129k | Apache-2.0 | bounded | resumable | Sandboxed execution as the default posture. |
| [pi](https://github.com/earendil-works/pi) | 114k | unclear | bounded | resumable | The upstream toolkit behind Pi Pocket and oh-my-pi: one multi-provider API, agent loop, TUI. |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 107k | Apache-2.0 | bounded | resumable | Generous free tier; Qwen Code forks its loop for open-weight models. |
| [OpenHands](https://github.com/OpenHands/OpenHands) | 90.6k | multi | headless | resumable | Dockerized SWE agent; the self-host reference. |
| [Cline](https://github.com/cline/cline) | 70.2k | Apache-2.0 | step-gated | resumable | Plan-then-act with per-step approval and cost transparency. |
| [goose](https://github.com/aaif-goose/goose) | 55.2k | Apache-2.0 | headless | resumable | Linux Foundation; MCP/ACP extension model with recipes. |
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | 35k | MIT | bounded | resumable | The fork we mine: hash-anchored edits, per-model tool loop, LSP/DAP, AST edits, subagents. |
| [crush](https://github.com/charmbracelet/crush) | 28.6k | FSL-1.1-MIT | bounded | resumable | Session persistence and the nicest terminal UI. |
| [qwen-code](https://github.com/QwenLM/qwen-code) | 28.4k | unclear | bounded | resumable | Gemini CLI's loop retuned for Qwen — closest upstream to our models. |
| [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | 21.9k | Apache-2.0 | headless | resumable | Self-improving harness; 95.5% on ARC-AGI-3 with Opus 5. Budgets, REPL, programmatic subagents. |
| [Hermes](https://github.com/NousResearch/hermes-agent) | 253k | Apache-2.0 | headless | resumable | Self-improving, checkpoints to disk with rollback; lean. |
| [OpenClaw](https://github.com/openclaw/openclaw) | 392k | Apache-2.0 | headless | resumable | The always-on personal agent; one input queue for messages, crons, webhooks. |
| [QM](https://github.com/yc-software/qm) | 15.4k | Apache-2.0 | headless | durable | YC's: three core tools, scoped memory, Postgres-backed durable sandbox. |
| [OpenJarvis](https://github.com/open-jarvis/OpenJarvis) | 11k | Apache-2.0 | headless | none | Local-first; evals that count energy, latency, and dollars. |

**Why the harness matters more than the model** (the evidence people quote, all **measured**):

| Finding | Number | Source |
|---|---|---|
| Bare model vs harness, same weights, ARC-AGI-3 | ~30% → **95.5%** (Opus 5, Prime Agent) | [arXiv:2608.23552](https://arxiv.org/abs/2608.23552) |
| Harness-only swap, SWE-bench Pro | GLM-5.2 **23% → 52%**; Gemma 4 26B **15% → 36%** | [@joelniklaus](https://x.com/joelniklaus/status/2085725862142623875) |
| Same model, two harnesses (Cursor's benchmark) | **46% vs 80%** | [MindStudio](https://www.mindstudio.ai/blog/agent-harness-scaffolding-matters-more-than-model) |
| Rank correlation across models | **≈ -0.05** (rankings do not transfer) | [arXiv:2605.27922](https://arxiv.org/abs/2605.27922) |
| Harness search vs hand design | **+7.7 pts**, **4× fewer** context tokens | [arXiv:2603.28052](https://arxiv.org/abs/2603.28052) |

The two lessons that matter here: **expose what the model cannot do for itself** (compaction, a
persistent REPL, programmatic subagents) and **drop imposed procedure** the model now runs on its
own (fixed plan-act-critique loops). The right amount of harness shrinks as models improve.

---

## 2. Context fitting

**The one principle: progressive disclosure.** Give the model a map first, load details only when
needed. Bloat enters through three doors — instructions, tool schemas, and tool output — and each
has a fix.

| Layer | Loaded | Guards | Scales by |
|---|---|---|---|
| `AGENTS.md` | every session | instructions | nesting (one file per directory) |
| `CLAUDE.md` | every session (Claude-only) | instructions | global/project/local files stack |
| Skills (`SKILL.md`) | when the task matches | instructions | adding skills is nearly free until triggered |
| MCP tool search | when the agent searches | tool schemas | automatically |

Built-in tool search (shipped in Claude Code, January 2026) is the platform absorbing this
category: Anthropic claims **~85% fewer tool-definition tokens** (**vendor**). Our own move is the
same idea applied more cheaply: one tool per MCP server instead of one schema per call, plus the
per-role skill catalog.

**Tool schemas are the expensive door at agent start.** Measured first-call context in
characters (**vendor**, [SpecPi research](https://tannermidd.github.io/SpecPi/research/)): Pi stock
**5,521**; SpecPi default 12,287; OpenCode 31,043; DSH 31,743; **OMP 66,708**; Claude Code 90,460.
Terminal-Bench 2.0 solve rates in the same study: SpecPi 0.805, OpenCode 0.744, Pi 0.713, **OMP
0.762**, DSH 0.553, Claude Code 0.723. The OMP complaint is real: the always-on surface is not
free, and we should keep ours small. Our measured router start context is **13,133** tokens
(Oh-My-Pocket), against OMP's **15,900** and stock Pi Pocket with a router prompt at **22,726**.

**Tool output is the biggest leak of all.** In one measured SWE-agent study (**measured**,
[The Complexity Trap](https://arxiv.org/abs/2508.21433), NeurIPS 2025 DL4C workshop),
environment observations were **~84% of an average turn**. See §3.

**Keep the prefix byte-stable.** KV/prompt reuse depends on prefix continuity and nothing else:
put volatile content (timestamps, request ids, counters, dynamic tool lists, "the time now") at the
**end**, never in the system preamble; append rather than rewrite. Measured: a stable-prefix
strategy hit **85.2%** cache hit rate (reusing ~46,059 tokens/request) versus **0%** for perturbed
prompts; disabling one attribution header took a session from reprocessing **15k–25k tokens** per
request to a normal prefill. Our own waiting-subagents work moved cached share from **60% to 90%**
by keeping the parent from taking a turn while a stage runs.

**Caveat for this stack:** NInfer is not `llama-server`, so the llama.cpp cache flags
(`cache_prompt`, `--cache-reuse`, `--ctx-checkpoints`) do not apply as written. What does apply is
prefix stability and model pinning: llama-swap swapping the resident model (27B ↔ 35B) discards the
slot's KV state, so a pipeline that alternates models pays full prefill on every switch.

**Read the meter, don't guess.** DSH exposes `tokenUsage`, `contextPressure`, and
`contextBreakdown` ("whether the bill came from system prompt, tool schemas, file reads or
conversation replay"). We already built the local equivalent: the context meter splits context into
prompt sections, tool schemas, and history by kind, scaled to the newest measured prompt. The next
step is per-section attribution in the A/B loop (which prompt section or tool caused a delta).

---

## 3. Auto-compaction

The field has converged on one shape, getting progressively more careful:

> **threshold → deterministic prune → (only if still over) LLM summary**

### What the reference implementations do

**Pi** (upstream of this project) — **measured** from [pi.dev/docs/latest/compaction](https://pi.dev/docs/latest/compaction):

- Auto-compaction triggers when `contextTokens > contextWindow - reserveTokens`. Default
  `reserveTokens` = **16,384**, `keepRecentTokens` = **20,000**; both configurable per model via
  `compaction.modelOverrides`.
- The cut point walks backward until `keepRecentTokens` is reached; valid cuts are user/assistant/
  bash/custom messages, **never** tool results (they stay with their call).
- Repeated compactions re-summarise from the previous compaction's kept boundary, so nothing kept
  earlier is silently dropped.
- Summary format is structured: Goal, Constraints & Preferences, Progress (Done/In Progress/Blocked),
  Key Decisions, Next Steps, Critical Context, plus `<read-files>`/`<modified-files>`.
- **Tool results are truncated to 2,000 characters during serialization** before the summary
  request, because they are the largest contributors to context. It also omits thinking blocks
  (replayed thinking is often not in live context; including it can make the summary request larger
  than the context it summarises).
- The seam is `session_before_compact` (and `session_compact_failed`): an extension can cancel or
  supply its own summary, with the previous summary, file ops, `tokensBefore`, and the kept
  boundary handed to it. This is how PiP already writes its own summaries.
- Summarisation requests disable prompt-cache writes (one-off prompts are unlikely to be reused).

**Claude Code** — **measured**, from Anthropic docs and field analysis:

- Auto-compact fires as the window fills; the documented default trigger sits around **83.5%**
  usage with a compaction buffer of **~33K tokens (16.5%)** (previously ~45K/22.5%), and models
  with a native 1M window compact "at about 967K tokens by default".
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100) moves the trigger; the window is capped at the model's
  real context.
- The API's server-side strategy `compact_20260112` defaults to a **150,000-token** trigger with a
  **50,000-token** minimum, and can `pause_after_compaction`.
- Reported failure mode (**measured**, field reports): auto-compact firing when it should not
  (e.g. at session start) and leaving *less* usable context than before. The fix is a real
  threshold, not compaction on a hair-trigger.

**DeepSeek Harness (DSH)** — **unverified** design, from its `AGENTS.md` and package map:

- `compaction/` runs a model-free `toolResultPruner.pruneSession()` **before** choosing the
  compactable range. This is the cleanest statement of the order: prune first, summarise only if
  that was not enough.
- `spill/` offloads large tool outputs instead of injecting them, and `guard/` is a first-class
  package for loop/tool guards.

### Why deterministic pruning first

**Observation masking** (**measured**, JetBrains, [arXiv:2508.21433](https://arxiv.org/abs/2508.21433)):
replace old tool observations with short placeholders, keep the last M in full, and summarise only
if still over.

- Observations were **~84%** of an average SWE-agent turn.
- Masking **halves cost** and matches or slightly exceeds LLM summarization on solve rate
  (Qwen3-Coder 480B: 53.8% raw → **54.8%** masked; summarization slightly lower).
- Hybrid masking + summary cut cost a further **7% vs masking / 11% vs summarization**, with
  **+~2.6 pts** success and ~$35 saved.
- Threshold guidance: **prune at ~85% utilisation, summarise only at ~95%**.

Follow-on result (**measured**): SWE-Pruner reports **23–54%** token reduction on SWE-Bench Verified
and up to **14.84×** on LongCodeQA with "minimal performance impact"
([arXiv:2601.16746](https://arxiv.org/html/2601.16746v1)).

### What we already have, and the gap

Shipped here: background compaction **off** (`compaction.backgroundTokens = 0`; a one-slot local
server would only queue the background summary behind the turn it was meant to overlap); PiP
compacts itself sooner than a session and writes its own summaries; the context meter shows the
before/after.

The gap is the DSH/masking order: we summarise; we do not yet **prune deterministically before
summarising**, and there is no byte/line cap that keeps one big `read` or `bash` result from
eating the window before compaction ever runs.

---

## 4. Edit and read interfaces

### Edit formats

| Format | One line | Evidence | For local Qwen |
|---|---|---|---|
| Search/replace (Pi's `edit`) | exact old→new blocks, layered fuzzy matching | Aider: format swung GPT-4 Turbo **26%→59%**; helped decide whole-file for 3.5, diff for 4 | Current default; keep |
| Whole-file rewrite | model re-emits the file | Cursor: better for files **under 400 lines** | Too expensive here |
| `apply_patch` (OpenAI diff blob) | strict freeform diff | Failure **50.7%** (Grok 4), **46.2%** (GLM-4.7) | Avoid |
| Hashline / content-hash anchors | model cites line hashes; stale rejects | **6.7%→68.3%** on Grok Code Fast 1, **+15 pts** avg over patch (16 models), **−61%** output tokens | A/B before porting |
| 4-char tokenizer-friendly anchors | anchors not content-derived | Explicit Edit Benchmark **99.3%** (226 tasks) | Same caveat |

**The honest caveat** (from the prior verification pass): the big hashline numbers are
**vs `apply_patch`**, not vs search/replace. Against replace, hashline's long-standing comparison
shows gains of **-1.7 to +11.3 points**, with Qwen Turbo **−1.7** and DeepSeek V3.2 **−8.3**. There
are no local 27B/35B results. Diff-XYZ (JetBrains) adds the strongest caution: **smaller open models
benefit little from any diff-format choice** — so measure on NInfer before porting anything.
Conclusion: **do not adopt content-hash anchors blind**; A/B against Pi's `edit` on our models.

### Structural read

- **`ast-grep outline`** (tree-sitter "table of contents" per file/dir, no index): **measured**,
  median Claude Code cost **−35% on VS Code, −55% on Django, −40% on OkHttp** with coverage and
  precision held at 100%.
- **`ast-outline`** (stateless tree-sitter CLI, `digest`/`outline`/`show`/`grep`): claimed
  "2–10× smaller" per-file read and 60–100 lines per map; **no independent benchmark**. Its
  no-index design matches our multi-worktree/fork model.
- **Structural vs lexical search** (**measured**, [arXiv:2607.12161](https://arxiv.org/html/2607.12161v4)):
  an ast-grep hybrid returned **170.9 matches / 2,090 tokens / 0.995 precision** vs ripgrep
  **310.9 / 2,905 / 0.66**; on point-definition queries **17.2 / 335.4 / 0.99 vs 75.6 / 752.8 /
  0.44**; under a 150-token budget, gold survival **85.7% vs 28.6%**. The same paper warns token
  reduction ≠ cost reduction.
- **`cocoindex-code`** (2.9k stars): tree-sitter/AST code search CLI and MCP server, no index to
  invalidate across worktrees.

### Read caps and repeat reads

- Lower default `read` limit + a structural summary, and superseding a stale read of the same file,
  are already on our README "Next".
- **`pi-readcache`** (**unverified**, MIT): returns `unchanged` / `unchanged_range` / a useful diff
  instead of re-sending file text, with compaction-safe trust reconstruction. Directly targets
  re-read cost; measure with the meter.

### LSP diagnostics

- OMP ships LSP with `workspace/willRenameFiles` wired into every write (**unverified**).
- Third-party (**measured**, CircleCI): LSP was the only config that "never missed"; on grep alone,
  Sonnet missed 2 `trigger` refs (9/11) and undercounted `effect` (249/260): **"the weaker the
  model, the more the LSP helps."**
- Counter-evidence: an N=1 Pi extension test was **inconclusive** and left LSP off.
- Read: LSP's value here is **diagnostics after edits** as a cheap replacement for repeated
  `tsc`/`cargo check`, not the full op surface.

---

## 5. Subagents and loop prevention

**Cold-start by construction.** DSH reports `inheritsParentContext: false` for subagents: every
delegation is a standalone task text plus the parent working directory (**unverified**, but the
single most useful design fact in the package map). It forces handoff hygiene instead of hoping
for it. OMP's `task` returns a schema-validated object the parent reads directly, "no prose to
parse" (**unverified**).

**Pass pointers, not payloads.** Anthropic's context-engineering guidance: subagents explore with
tens of thousands of tokens but return a condensed summary; prefer file-based memory. The `/handoff`
pattern is explicit: "use pointers instead of repeating everything", and handoff files are
disposable. The 4-step protocol sanitises the child's context so a child never sees unrelated
reports it would try to fix (**all unverified**).

Our version is already pointer-based (roles.yaml: "context passed as FILE POINTERS (plan.md,
review.md)"), plus agent definitions and `wait: true` to keep one stage resident.

**The cheapest measured loop fix.** Adding one line — *"NEVER repeat the same failing tool call more
than once. If it failed, change your approach…"* — took a local qwen3:14b from **~30,000 tokens /
10+ calls / <20% tool success / task failed** to **8,946 tokens / 3 calls / 100% success / task
completed** (**measured**, dev.to local-LLM test). A deterministic guard is the same idea enforced
by the runtime: DSH ships `guard/`; OMP aborts a stream mid-token on a regex and injects a
reminder (`time-travel stream rules`, survives compaction) (**unverified**). The best-of list also
ships a **`runaway-guard`** skill: a hook that stops a session when the agent repeats a call, keeps
failing, or spends past a dollar cap.

**Tool-call repair.** Specialists underperform through OpenAI-compatible servers because of
**chat-template mismatch** (**measured**, jdhodges): Hammer 2.1 7B scored 20% on one harness but
8/8 on "don't call" edge cases. Our one-MCP-tool move is right; also validate the model's actual
tool-call wire format through llama-swap, and consider a lenient-JSON repair shim (OMP's changelog
lists "reported malformed tool json to lenient tools").

---

## 6. Skills

A skill is a folder an agent loads when a task matches: a `SKILL.md` plus any scripts. It is
progressive disclosure in its purest form, and the one caution from the field is that **skills only
help when they trigger** — teams struggle with routing. Our per-role catalog battery is the local
fix: wrap the `skills` prompt section and render only the session role's list (`router start
context 19,395 → 13,133 tokens`).

### The ten audit skills (best-of-Agent-Harnesses, MIT)

These are not features to port; they are setup audits worth running, each with a number and a script:

| Skill | What it gives you |
|---|---|
| `harness-test-drive` | Runs agents on tasks from your own git history, scored by your own tests: pass rate, minutes, cost. |
| `agents-md-checker` | Which instruction files each agent loads, what gets cut, whether the commands still work. |
| `tool-design-checker` | Grades each MCP tool the way a model reads it; token load per server; colliding tools. |
| `sandbox-check` | What the agent can reach (secrets, hooks, Docker, sudo, network) vs what settings claim. |
| `guardrail-tester` | How many of ~90 dangerous commands your rules block vs only ask. |
| `runaway-guard` | Stops a live session on repeat calls, repeated failure, or a dollar cap. |
| `claim-check` | How often the agent claimed tests passed without a passing run; whether tests were weakened. |
| `rules-to-guards` | Finds the AGENTS.md rules your agent breaks and turns each into a tested hook. |
| `session-waste-report` | Where tokens go: re-reads, huge tool outputs, polling, cache-expiring pauses. |
| `regression-finder` | Splits sessions by version/model/week and finds where behaviour changed. |

Install one with `npx skills add <repo>/tree/main/skills/<name>`, or point the best-of MCP server's
`get_skill` at it.

### Skill packs people like

| Pack | Stars | What it is |
|---|---|---|
| [superpowers](https://github.com/obra/superpowers) | 298k | Performance-oriented harness pack for Claude Code + 13 others: skills, instincts, memory, security, research-first workflows. |
| [Anthropic Skills](https://github.com/anthropics/skills) | 180k | The reference for `SKILL.md` progressive disclosure. |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 105k | 24 senior-dev workflow skills across 70+ agents. |
| [wshobson/agents](https://github.com/wshobson/agents) | 40.4k | Cross-harness marketplace of drop-in subagents and skills. |
| [planning-with-files](https://github.com/OthmanAdi/planning-with-files) | 27.4k | Crash-proof markdown plans, recovery after `/clear`/compaction, a deterministic completion gate. |
| [get-shit-done](https://github.com/open-gsd/gsd-core) | 10.4k | Goal-backward planning over fresh context windows; avoids context rot by design. |

**Pitfalls (measured for OMP):** auto-discovering a whole `~/.claude` or `~/.agents` skill library
is context bloat; OMP users explicitly disable `enableClaudeUser`, and our OMP config sets
`skills.enableAgentsUser: false` with only `stop-slop` on. Keep autoloaded sets tiny; every
autoload line is prefill.

---

## 7. Performance levers

**Per-stage thinking budgets.** Qwen3.x supports `reasoning_effort` (`low`/`medium`/`xhigh`) and
`enable_thinking: false`. Choosing low/medium or disabling thinking "typically cuts thinking-token
spend by **60–90%**" (**vendor**). Our roles already set thinking per role (plan/review `xhigh`,
coder/agent `medium`, `-fast` roles `low`); the open question is whether that reaches NInfer
honestly — Qwen 3.5/3.8 templates have been buggy at honouring the budget, so verify the effective
`<|think_on|>`/`<|think_off|>` token on our build.

**Speculative / n-gram decoding.** llama.cpp `--spec-draft-n-max` defaults to 3; EAGLE-3 and
speculative pairs report **1.5–3×** with "no degradation in quality" (**vendor**). On a single
24 GB card a draft model competes with the 27B/35B target for VRAM, so prefer **lookup / n-gram
decoding** (no second model) first: it helps most on repetitive code and costs only cache RAM.

**Pin one model per run.** Because a llama-swap swap discards the slot's KV state, a pipeline that
alternates 27B ↔ 35B pays full prefill on every switch. One stage at a time on one resident model is
the rule we already follow; keep it.

**Harness search beats hand design** (**measured**): Meta-Harness searched over harness code end to
end and beat a state-of-the-art context manager by **7.7 points** while using **4× fewer** context
tokens. The takeaway is not to build a search loop now, but to treat the harness as the variable to
tune, with evals as the signal (LangChain's "better harness" recipe: hill-climb with evals).

---

## 8. Ranked improvements for Oh-My-Pocket

Effort: **S** = config/wiring only, **M** = small extension, **L** = new subsystem. Status: **next**
= already on the README "Next", **new** = not yet written down.

| # | Change | Effort | Status | Evidence | Where it lands |
|---|---|---|---|---|---|
| 1 | **Deterministic tool-output pruner at compaction** — mask old observations to placeholders, keep the last M in full; summarise only if still over | S | next | masking halves cost, equal/better solve (**measured**) | compaction setting + `session_before_compact` hook |
| 2 | **Loop guard + no-repeat line + lenient tool-JSON repair** | S | new | 30K→8.9K tokens, <20%→100% success (**measured**) | `_rules.md` + a `beforeTool` hook |
| 3 | **Lower default `read` limit with a structural summary; supersede stale reads; drop useless turns pre-compaction** | S/M | next | ast-grep outline −35–55% (**measured**); 2–10× smaller reads (**unverified**) | `read` wrapper + compaction hook |
| 4 | **KV-prefix discipline**: byte-stable system prompt, append-only, volatile data last, one model per run | S | new (mostly holds) | 85% vs 0% cache hit; 15k–25k re-prefill from one field (**measured**) | prompt sections / router recipe |
| 5 | **Per-stage thinking budget verified on NInfer** | S | new | 60–90% thinking-token cut (**vendor**) | roles.yaml (already set) + verify token |
| 6 | **Context meter: per-section attribution across an A/B** (name the row a change touched, before/after) | S/M | partially built | DSH `contextBreakdown` (**unverified**); meter exists (**measured**) | `context-meter.ts` + `/context` UI |
| 7 | **Handoff hygiene**: child gets file pointers + a typed result schema; brief/plan/review are the only injected artifacts | S | new (mostly holds) | DSH cold-start; Anthropic condensed-summary guidance (**unverified**) | agent definitions + subagent tool |
| 8 | **`pi-readcache`-style repeat-read suppression / DSH-style spill of huge outputs** | M | new | no number (**unverified**); targets re-read cost | `read`/`bash` wrappers |
| 9 | **Hash-anchored edits** — A/B only, do not port blind | M | new | vs replace: −1.7 to +11.3 pts incl. Qwen Turbo −1.7 (**measured**) | `edit` wrapper |
| 10 | **LSP diagnostics after edits** (diagnostics only) | M | new | LSP never missed, helps weaker models most; one N=1 inconclusive (**mixed**) | `afterTool` hook, optional |
| 11 | **N-gram / lookup speculative decoding** (draft model only if VRAM allows) | S | new | 1.5–3× (**vendor**); competes for VRAM | llama-swap config (not the harness) |

### Notes on the top items

**1. Prune before you summarise.** Today we go straight to an LLM summary. The order DSH uses
(`toolResultPruner.pruneSession()` then decide the compactable range) is free when mask alone frees
enough room, and masking matches or beats summarization on solve rate. It also keeps the KV prefix
intact in the common case because it never calls a second model. This is the single best cheap win
in the whole survey.

**2. Guard the loop.** A local server answers one request at a time; a model that repeats a failing
call burns the whole slot. The one-line rule plus a `beforeTool` guard that blocks an identical
call after one failure is a few lines of config and a hook, and the measured swing is the largest
of any cheap change here.

**3–4. Read less, and never disturb the prefix.** Cap reads, hand back a structural summary, and
keep the prompt prefix byte-stable with volatile data at the end. These are precondition changes:
they make items 1, 6, and 8 measurable.

**9. Hashline is not yet decided.** The headline 10× is against `apply_patch`, not against our
search/replace, and small open models often gain little from format choice. Put it in the arena on
NInfer: same task, `edit` vs hashline, count failed edits and output tokens.

### Already shipped (do not re-recommend)

Agent definitions; background compaction off; titles on the session's model; plan mode reading the
board; per-role skill catalog; the context meter; waiting subagents. Each has measure or test
evidence in the README "Batteries" table.

---

## 9. Skip these (bloat for this stack)

- **`apply_patch` / OpenAI-flavoured diffs and udiff for local Qwen** — patch failure 50.7%/46.2%
  on non-tuned models; Aider only chose `diff` for GPT-4.
- **JSON/structured edit schemas** — models edit code worse with structured formats (Aider).
- **Whole-file rewrite as the default** — only justified under ~400 lines.
- **Full LSP surface / an LSP-per-language MCP** — schema bytes for a diagnostics job.
- **Vector-index / embedding RAG over the repo** — an index to invalidate per worktree, when grep +
  `ast-grep outline` returns 0.995-precision candidates for far fewer tokens.
- **More MCP servers / more tools** — OMP's 66,708-char first call is what tool sprawl costs.
- **Background/async or cloud summariser compaction** — a second model call that invalidates the
  prefix cache; we already turned it off. Mask first.
- **Speculative decoding with a large draft model or EAGLE-3/Medusa heads** — VRAM contention on one
  24 GB card; start with n-gram.
- **`billion-context`-style LLM compression plugins** — model calls for a job deterministic masking
  does free.
- **A second "advisor" model watching every turn** — doubles cost on a one-request-at-a-time GPU.
- **Skill/plugin auto-discovery of the whole `~/.claude` library** — measured context bloat; OMP
  disables it and so do we.
- **Memory backends, browser/computer-use, web search, TTS/image-gen, collab, GitHub-as-a-filesystem,
  TUI themes, plugin marketplaces** — features, not output/speed/function for local models.
- **Fine-tuning as a first move** — the harness changes above deliver measured gains for $0.

---

## 10. Sources and verification

**Internal (this workstation).**

- `~/projects/oh-my-pocket/README.md` — the batteries table, T2 A/B, "Next".
- `~/projects/oh-my-pocket/docs/{index,features,map,extensions}.md`, `src/server/context-meter.ts`,
  `src/server/pip-compact.ts`, `src/server/compaction.ts`.
- `~/handoffs/oh-my-pocket/2026-10-11-dsh-review/{research.md,research-big.md}` — prior DSH review
  and the first ranked top-10, with a Claude verification pass appended.
- `~/homelab/harnesses/{omp/config.yml,agents/roles/roles.yaml}` — the local role matrix and OMP
  settings this doc assumes.

**External (fetched as text, 2026-10-11).**

- best-of-Agent-Harnesses: [README/llms.txt](https://github.com/RyanAlberts/best-of-Agent-Harnesses),
  [progressive-disclosure](https://ryanalberts.github.io/best-of-Agent-Harnesses/compare/progressive-disclosure/),
  [why-the-harness-matters](https://ryanalberts.github.io/best-of-Agent-Harnesses/compare/why-the-harness-matters/),
  [terminal-coding-agents](https://ryanalberts.github.io/best-of-Agent-Harnesses/compare/terminal-coding-agents/),
  [skills](https://ryanalberts.github.io/best-of-Agent-Harnesses/skills/). CC-BY-SA-4.0; summarised
  here with links.
- Pi compaction: [pi.dev/docs/latest/compaction](https://pi.dev/docs/latest/compaction) (**measured**
  from the reference; the real thing to compare against is Pi Durable's README in
  `node_modules/@earendil-works/pi-durable/`).
- Claude Code auto-compact: [Anthropic compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction),
  [context-buffer analysis](https://claudefa.st/blog/guide/mechanics/context-buffer-management),
  [the auto-compact paradox](https://gist.github.com/yurukusa/219bf5556f5508b0add25d0be47534fa)
  (**measured** field reports; thresholds are model- and environment-dependent).
- Masking: [The Complexity Trap, arXiv:2508.21433](https://arxiv.org/abs/2508.21433);
  [SWE-Pruner, arXiv:2601.16746](https://arxiv.org/html/2601.16746v1).
- Edit formats: [Aider](https://aider.chat/docs/more/edit-formats.html),
  [Stencil/OMP harness problem](https://stencil.so/blog/the-harness-problem),
  [Diff-XYZ, arXiv:2510.12487](https://arxiv.org/html/2510.12487v2),
  [Explicit Edit Benchmark](https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark).
- Structural search: [ast-grep outline](https://astgrep.com/guide/outline-code),
  [ast-outline](https://github.com/ast-outline/ast-outline),
  [arXiv:2607.12161](https://arxiv.org/html/2607.12161v4).
- Harness-matters studies: [Prime Agent, arXiv:2608.23552](https://arxiv.org/abs/2608.23552),
  [Harness-Bench, arXiv:2605.27922](https://arxiv.org/abs/2605.27922),
  [Meta-Harness, arXiv:2603.28052](https://arxiv.org/abs/2603.28052),
  [SWE-agent, arXiv:2405.15793](https://arxiv.org/abs/2405.15793).

**Caveats.** Stars are a snapshot and reward age and novelty, not quality. Vendor numbers
(SpecPi, LM Studio, Apache/llama.cpp, Anthropic tool-search, Qwen thinking budgets) are directional.
The hashline, ast-outline, `pi-readcache`, DSH package, and OMP RLM/task claims carry **no
independent local measurement**; each is marked above and none is a decision until it is A/Bed on
NInfer and read back through `/api/metrics/activity` and the context meter.

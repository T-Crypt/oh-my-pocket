# Rate-limit wait (design for 0.21.0)

Status: built for 0.21.0 (see "What was built differently" at the end). Facts were checked in this checkout (Pi Pocket 0.20.1, `@earendil-works/pi-durable` 1.3.0, `@earendil-works/pi-ai` 1.3.0). Things not checked against a live provider are marked **(verify)**.

The request: Pi Pocket should handle 429s and similar errors well. A run that hits a limit should wait, check smartly, and continue by itself when the provider answers again.

## 1. What happens today

Two layers exist. Pi Pocket adds no layer of its own.

1. **pi-ai provider retry** (`pi-ai/dist/utils/provider-retry.js`). It is off. `maxRetries` is undefined, so it is 0 (`provider-retry.js` `options.maxRetries ?? 0`; Pi's `getProviderRetrySettings` gives no default, `settings-defaults.js` line 22). When on, it reads `retry-after-ms` and `retry-after`, and fails at once for a delay over `maxRetryDelayMs` (60 s, `provider-retry.js` line 1 and 23). The failure text is "Server requested Ns retry delay (max: 60s). …".
2. **Pi Durable generation retry** (`pi-durable/dist/harness/generation.js` lines 386-411). It reads only the error text. `isRetryableAssistantError` (`pi-ai/dist/utils/retry.js` line 193) decides. The policy is `DEFAULT_RETRY_POLICY` (`harness/agent.js` lines 4-9): 3 retries, 2 s, 4 s, 8 s (`retryDelayMs`, `retry.js` line 99), at most 60 s each. Pi Pocket passes Pi's retry settings as a live getter (`app.ts` line 1069), so a person can change these numbers in `~/.pi/agent/settings.json`, but never to hours.

While Durable waits, `live.generation.retry = { at, error }` is set. `projection.ts` line 599 sends it. `web/transcript.js` lines 2484-2535 show "Retrying in Ns" and the error text. The wait is a durable `retry` phase (`generation.js` line 132: `runtime.sleep(until)`), so it survives a restart.

| Case                                                                                                           | Classified as                                                                                                                                                                                                                                                                                                | Where it ends                                                                                                                            | What the person sees                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Short 429 (rate limit, text has "429" or "rate limit")                                                         | retryable                                                                                                                                                                                                                                                                                                    | Durable: 3 retries (14 s in all), then the run fails `model_error` (`generation.js` line 406)                                            | "Retrying in Ns" for 14 s, then a failed run     |
| 429 with a long `Retry-After`                                                                                  | retryable by accident: the text "retry delay" matches (`retry.js`). Only if provider retry is on. Otherwise `Retry-After` is not read at all                                                                                                                                                                 | Same: 3 short retries, then failed                                                                                                       | Same. The real delay is lost                     |
| 5xx, 529 overloaded, network error                                                                             | retryable                                                                                                                                                                                                                                                                                                    | Same: 14 s, then failed                                                                                                                  | Same                                             |
| Subscription window (Claude 5 hours, ChatGPT)                                                                  | Codex: text "You have hit your ChatGPT usage limit … Try again in ~N min" (`openai-codex-responses.js` line 1256) matches no pattern, so it is not retryable. `subscription_sharing_usage_limit_exceeded` is listed not retryable. Claude: a 429 `rate_limit_error` is retryable **(verify the exact text)** | Codex: fails at once. Claude: 14 s, then fails                                                                                           | A failed run                                     |
| Monthly or billing limit (`Monthly usage limit reached`, `GoUsageLimitError`, `insufficient_quota`, "billing") | not retryable (`retry.js` line 1-20)                                                                                                                                                                                                                                                                         | Fails at once                                                                                                                            | A failed run                                     |
| Expired sign-in                                                                                                | `ModelsError` "OAuth refresh failed for X". Not retryable                                                                                                                                                                                                                                                    | Fails at once. `app.ts` lines 857-863 call `providers.runFailed` (`providers.ts` line 161), which marks the provider and tells the owner | A failed run, a model menu mark, an owner notice |

A failed run is shown in all the same ways, with the reset time often lost:

- Session list: `#failed` (`app.ts` lines 870-880, 2037) gives the "Failed" square (`web/sessions.js` line 288).
- Push: "Pi stopped with an error" (`alerts.ts` `#pushDone`, line 88).
- Notice: `No answer (model_error): …` (`commands.ts` line 1133).
- The person must send the message again. "Retry" forks the session (`commands.ts` lines 1930-2000); there is no in-place continue.

Other callers:

- **Subagents** treat a limit as a model failure (`extensions/subagents.ts` lines 265-272, `PROVIDER_TROUBLE`). They tell Pi to stop and tell the person (`MODEL_FAILED`).
- **Schedules, webhooks, PR watches, repo watches, linked sessions, and PiP** all send through `Commands.submit`. They get the same run, so the same failure. PiP's follow reports the failure at the end.
- **Titles** (`titles.ts` line 116) and **PiP summaries** (`pip-compact.ts` line 402) call `completeSimple` and fail quietly or loudly on their own.

## 2. How a provider says when it is available again

What each provider sends **(verify each with a captured response; the first two rows are not confirmed in this checkout)**:

| Provider                      | Signals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API key             | `retry-after` (seconds); `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset` (RFC 3339)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Anthropic Claude subscription | `anthropic-ratelimit-unified-status`, `-unified-reset` (epoch seconds), `-unified-5h-reset`, `-unified-7d-reset`, `-unified-representative-claim`. These are what Claude Code reads. Pi Pocket's own usage page reads `GET https://api.anthropic.com/api/oauth/usage` (`resets_at` per window; confirmed in `~/.pi-pocket/extensions/subscription-usage.ts` line 312) Read as built: a rejected `-unified-5h-status` waits for `-unified-5h-reset`; a rejected `-unified-7d-status` is days away, so it does not wait and fails with `-unified-7d-reset` in its text (tested against real limits in PR #128 by @piromagnus). |
| OpenAI API                    | `retry-after`; `x-ratelimit-reset-requests` and `-tokens` (durations such as `6m0s`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ChatGPT sign-in (Codex)       | The 429 body has `resets_at` (epoch seconds) and `resets_in_seconds`. pi-ai reads `resets_at` into the text "Try again in ~N min" (confirmed, `openai-codex-responses.js` lines 1250-1256). Response headers `x-codex-primary-*` and `-secondary-*` **(verify)**. A usage read costs a spawned `codex app-server` today Read as built: a window with `x-codex-<primary or secondary>-used-percent` of 100 waits for its `-reset-at` or `-reset-after-seconds`; if its `-window-minutes` is over 300 it is a weekly limit, and it does not wait (PR #128).                                                                    |
| OpenCode Go                   | Error type `GoUsageLimitError` and the text "Monthly usage limit reached". Usage endpoint `GET https://opencode.ai/zen/go/v1/usage` has `resetsAt` for the rolling, weekly, and monthly windows (confirmed, `subscription-usage.ts` line 454)                                                                                                                                                                                                                                                                                                                                                                                |
| OpenRouter                    | Sometimes `retry-after`; a 402 for credits (not a wait)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Google                        | `RetryInfo` `retryDelay` in the body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Can the information reach Pi Pocket today?**

- Error **text**: yes. pi-ai puts the SDK's message, with the body, in `AssistantMessage.errorMessage` (cut at 4000 characters, `error-body.js`). Pi Durable gets only this.
- Error **headers**: no. The Anthropic and OpenAI SDKs throw on a 429 before `onResponse` runs (`anthropic-messages.js` line 478 is after the request). Only Codex calls `onResponse` before its ok check (`openai-codex-responses.js` line 284).
- **The smallest way, in Pi Pocket alone:** `StreamOptions.fetch` (`pi-ai/dist/types.d.ts` line 57) is used by the Anthropic, OpenAI (completions and responses), Codex, and Mistral adapters. Pi Pocket already wraps `models.streamSimple` in core in two places: `timing.ts` (`measureModelStreams`, `app.ts` line 598) and `installRequestShaping` (`app.ts` line 3074). A third wrapper can pass a `fetch` that records status and headers of each response, and it can read the error text. Google and Bedrock do not take it: for those, text and backoff only.
- **Usage endpoints** give a reset time without spending tokens. Core does not call them. An extension can (section 4).

## 3. Proposed design

### The idea

A **limit gate** wraps every model stream. When an attempt fails with a waitable limit before any content arrives, the wrapper does not return the error. It waits, then tries again, inside the same stream. Pi Durable sees one slow request, not a failure.

Why this works with no Pi Durable change:

- A restart replays the `request` phase (`generation.js` `request`: it converts a partial, then asks again). The replay sends the request again, gets the limit again, and waits again. So the wait survives a restart. No wait state is the source of truth.
- Stop (`conversation.abort`, Esc twice) aborts `options.signal`. The wrapper ends its wait at once.
- Subagents, linked sessions, PiP, schedules, webhooks, and watches all use `Commands.submit`, so all use the gate with no change. A subagent just takes longer. Its parent sees a subagent at work.

The wait is **not** Durable's `retry` phase. That phase is the better home for a long wait (checkpointed `until`, the existing "Retrying" display). It needs a Pi Durable change. See section 5.

### What waits, and until when

The wrapper classifies the failed attempt from status, headers, and text (`src/server/limits.ts`, pure functions, tested with real error strings):

| Kind      | Examples                                                                                                                                 | Action                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `reset`   | A reset time is known: `anthropic-ratelimit-unified-reset`, `resets_at`, "Try again in ~N min", `retry-after` over 60 s                  | Wait until reset plus 5 to 30 s of jitter. Then try once (the canary, below) |
| `backoff` | 429 or 529 or 5xx with no time                                                                                                           | Wait 15 s, 30 s, 1 min, 2 min, 5 min, then 10 min each                       |
| `no-wait` | Expired sign-in, 400, 401, 403, 402, "billing", "insufficient_quota", context overflow, content filter, a reset farther than the maximum | Pass the error to Pi Durable as today                                        |

Rules:

- A mid-stream failure after content started is **not** replayed. It passes to Pi Durable, which retries as today.
- **Maximum wait:** 6 hours for `reset` (covers the 5-hour windows), 30 minutes for `backoff`. A reset farther away (a weekly or monthly limit) is not waited for. The run fails at once, and the error text says when it resets.
- A wait is clamped to at least 5 s, so `retry-after: 0` cannot make a loop.
- After the gate gives up, it refuses fast for that key until the reset time or 5 minutes. Durable's own 3 short retries then end in a second, not a new 6-hour wait.
- The key is `provider/modelId`. Limits can be per model (an Opus weekly cap), so a session on another model is not held.

### How it checks without spending much

- **The canary is the real request.** A request that a provider rejects with 429 costs no tokens. Only **one** waiter per key sends it (single flight). The others wait for its result.
- If the canary succeeds, the gate opens. Waiters leave one by one, 1 to 5 s apart, so many sessions do not wake in the same second.
- If the canary fails again, the gate reads the new time, backs off, and waits more.
- A usage endpoint (Claude, OpenCode Go) can give a reset time earlier or more exactly. That comes later, through an extension point (section 4).
- No separate "ping" request is made. A cheap model call would spend tokens, and for subscriptions it counts against the window.

### What the person sees

- **Transcript live line:** "Waiting for Claude's limit · resets 14:05 (in 2 h 10 m)", with the reason line (the provider's text, cut to 300 characters, shown as text), **Retry now** and **Stop**. Stop is the existing abort. Retry now ends the wait of the key and sends the canary at once. Any person who may see and steer the session may press it.
- **Session list:** a new square shape `limited` (label "Waiting for a usage limit"), `data-state="limited"` on `session-row`. It sits after "waiting for approval" and before "working". Home's Jump back in uses the same function. The theme surface reference gets the new state.
- **Subagents board:** a subagent in a wait shows "waiting for limit".
- **Notifications:** one push when a wait starts that will take over 10 minutes (a new push kind `limit`), and the usual "Pi finished" push when the run ends. When the gate gives up, the usual failure push and notice follow, now with the reset time in the text.
- **Server data:** `ClientLive.limit = { key, provider, kind, until?, reason, probes }` (projection). The session list gets `limited: until`.
- A conversation is found from the stream by `options.sessionId`, by reading `ProviderDoc` of the busy conversations once when a wait starts. A subagent maps to its session with `rootOf`.

### New message while the run waits

It queues like a message to any busy run. The live line says "Your message goes after the wait. Stop to cancel." It never counts as Retry now.

### Titles and PiP summaries

They must not wait for hours. They pass an option `pocketNoWait: true`, which the wrapper reads and removes. They fail as today. Everything else waits (Durable's generation and compaction streams).

### Persistence

- **The run:** Pi Durable's task. A replay waits again. No new document kind.
- **A small cache** `provider-limits.json` in the data folder (plain file, written when a gate changes, read at start, expired entries dropped). It only stops a restart from sending one rejected request from each waiting session. If it is lost or stale, requests go out, fail, and the gate is built again. It is a hint, never a source of truth.

## 4. Where each part goes (rules C1 to C14)

| Part                                                                                                                 | Where                                                                                                                                                                          | Rule                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Classifier (status, headers, text to kind and time)                                                                  | Core, `src/server/limits.ts`                                                                                                                                                   | C5: must be the same for every session, provider, and extension                      |
| Gate, single flight, jitter, stream wrapper, restart behavior                                                        | Core, `limits.ts`, wired in `app.ts` next to `measureModelStreams` (the gate goes **outside** the timing wrapper, so tokens per second measure the last attempt only)          | C2 (replay), C3 (spend: one rejected request, no new model, no budget bypass), C5    |
| Maximum waits, on or off                                                                                             | Core, `config.json`, owner only, in the Providers sheet (`limitWaitHours`, 0 is off)                                                                                           | C3                                                                                   |
| Projection, session list `limited`, Retry now route (`POST /api/c/:id/limit/retry`, `requireSee` and `requireSteer`) | Core                                                                                                                                                                           | C1 (who may act), C5                                                                 |
| Live line, square, theme state, docs                                                                                 | Core, `web/`                                                                                                                                                                   | C5                                                                                   |
| Push kind `limit`                                                                                                    | Core, `alerts.ts`                                                                                                                                                              | C5                                                                                   |
| Subagent board text                                                                                                  | `extensions/subagents.ts` (small)                                                                                                                                              | C6                                                                                   |
| Reset times from usage endpoints                                                                                     | **Extension point** `host.limitResets(fn)` (experimental), used by the gallery `subscription-usage` module. That module reads the owner's sign-ins, so it stays in the gallery | C4, C6, C12, C15 (first user ships with it, or a tested example in `docs/examples/`) |
| Header and text parsers per provider                                                                                 | Core. They are protocol facts, with no credentials and no outside calls                                                                                                        | C5                                                                                   |

- **Spend and models (C3):** the wait costs nothing. A retry is the same request the person asked for. No automatic model switch or fallback is ever made. Only people choose models. A person can press Stop and pick another model.
- **Stored data (C2):** this design changes **no** document kind and adds none in v1. `docs.ts` is untouched. The only stored state is Pi Durable's own run, which resumes as before. If the owner later wants a document (`pocket.provider-limits`), adding a kind is safe for new stores, but a downgrade to 0.20 needs a test that an older build opens a store with an unknown kind **(verify)**. This is why v1 uses a plain cache file.
- **C14:** the new extension point has no built-in module. Its user is the gallery module. Core and extension go in separate commits (C17).

## 5. What needs another package

**Pi Pocket alone (all of v1):** the `fetch` wrapper, the classifier, the gate, the UI, the push.

**Wanted in pi-ai (not required):**

1. Put `status`, `retryAfterMs`, and `resetAt` on the failed `AssistantMessage` (a small `errorInfo`). Then the `fetch` wrapper is not needed.
2. Call `onResponse` for non-2xx responses in the SDK adapters.
3. Export a limit classifier. Today "Server requested 7200s retry delay" is classified as retryable by the words "retry delay", which wastes 14 s of retries and loses the time.

**Wanted in Pi Durable (not required):** let the host decide a retry. For example `settings.retry.decide(message, attempt) -> { retry, delayMs, maxAttempts }`, or a hint on the message (`retryAfterMs`). Then a long wait is Durable's durable `retry` phase: a checkpointed `until`, `live.generation.retry`, the existing "Retrying" display, and no in-memory timer. If it ships, the gate can use it for the wait and keep only the classifier and the single-flight canary. The user-visible behavior stays the same.

## 6. Risks

| Risk                                                                               | Answer                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spending with nobody present                                                       | A wait sends nothing but rejected requests. The run that continues is the one the person started. Tool approvals, plan mode, and the spend budget work at the same places as before. No model change. The maximum wait ends long unattended runs |
| Loops                                                                              | Minimum wait 5 s. Backoff grows. A cap on tries for each wait (40). The gate refuses fast after it gives up. A mid-stream failure is never replayed                                                                                              |
| Many sessions wake together                                                        | Single canary for each key, then release one at a time with 1 to 5 s of spacing. A restart reads the cache file first                                                                                                                            |
| A limit that never clears                                                          | The maximum wait (6 hours, or 30 minutes with no time). A reset farther away fails at once with the time in the text                                                                                                                             |
| A new message while waiting                                                        | It queues. The line says so. Stop cancels the wait                                                                                                                                                                                               |
| A person changes the model while it waits                                          | The run keeps waiting on the old model. The live line says so. Stop, then resend. To test: does `Commands.configure` while busy change the next request only?                                                                                    |
| A lying or odd header                                                              | Clamp to the range 5 s to the maximum. Show the provider's text only as plain text, cut to 300 characters (C4)                                                                                                                                   |
| A wait that hides a real failure (a wrong model name returns 404)                  | Only 429, 529, and 5xx without content, and texts known to be limits, wait. All others pass through                                                                                                                                              |
| The in-stream wait is invisible to Pi Durable (the `request` phase runs for hours) | I found no lease or heartbeat for a task phase in `harness/scheduler.js`. Test it with a faux provider, a 10 s wait, and a restart                                                                                                               |
| Pi Durable's replay on restart sends a request from each waiting session           | The cache file, and the gate's single flight after the first failure                                                                                                                                                                             |

## 7. Decisions needed

1. **In-stream wait now (Pi Pocket alone), or wait for a Pi Durable change?** Recommend: in-stream now. Ask for the Pi Durable hook later.
2. **Wait for subscription windows up to 6 hours, and for no-time errors up to 30 minutes?** Recommend: yes, both, with `limitWaitHours` in the Providers sheet. Weekly and monthly limits fail at once with the reset time.
3. **On by default?** Recommend: yes. A wait spends nothing, and the owner can turn it off.
4. **Gate key `provider/modelId` or `provider`?** Recommend: `provider/modelId`.
5. **No automatic model fallback, ever?** Recommend: confirm. It stays outside this feature (C3).
6. **Push when a wait of more than 10 minutes starts?** Recommend: yes, as a new push kind on by default for the people in the session.
7. **Extension point `host.limitResets` in v1 or v2?** Recommend: v2. v1 uses headers, bodies, and the canary only.
8. **Wait for a sign-in that expired (the person signs in again, then the run goes on)?** Recommend: not in v1. A person must act, and the run fails as today.
9. **A "Resume at reset" for weekly limits through `Schedules`?** Recommend: not in v1.

## 8. Size and plan

About 1,600 to 1,900 lines with tests and docs: `limits.ts` about 450, wiring 100, projection and routes 100, alerts 40, web 150, docs 150, tests 600.

Separate commits (C17: core first, extension last):

1. This design file.
2. `limits.ts`: classifier only, with table tests on real error strings from pi-ai and the providers. Header capture is not wired yet.
3. The gate and the stream wrapper, the `pocketNoWait` option in `titles.ts` and `pip-compact.ts`, and tests with the faux provider: 429 then success, Stop during a wait, a restart during a wait, 10 sessions with one canary, give up after the maximum.
4. Projection, session list `limited`, the Retry now route, the live line and the square, and the theme surface docs.
5. Setting `limitWaitHours` and the Providers sheet field. Push kind `limit`. The cache file.
6. Subagents board text, and the docs (`architecture.md`, `features.md`, `map.md`).
7. Later: `host.limitResets` and the gallery user.
8. Later, upstream: pi-ai and Pi Durable requests from section 5.

Checks for every commit: `npm run check`, `npm run lint`, `npm test`, `npm run format`.

## What was built differently

- **The gate key** for a limit that covers the account is the provider: `provider`. It has no token (an OAuth token changes at each renewal) and no sign-in counter (it starts again at each start), so a renewal and a restart keep the gate. A sign-in or sign-out here drops the provider's gates, and a failure of a request sent before one opens none. A limit that is not the account's (a 429, an overload, a cap for one Claude model) is held by `provider/modelId`. One account limit gives one canary.
- **`noWait`** is a symbol-marked option (`noWait(options)` in `limit-gate.ts`), not a plain `pocketNoWait` property, so the options type stays the provider's own.
- **The recording `fetch`** goes only to the adapters that take one (`anthropic-messages`, `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `mistral-conversations`, `pi-messages`). The Google adapters refuse a custom fetch. For the others the gate reads the error text only.
- **A plan's usage limit with no known reset** (for example "Monthly usage limit reached") is not waited for: it is `other`, and the run fails as before. There is no time to wait until.
- **Retry now** acts on the session's own wait and on its subagents' waits. A viewer cannot use it.
- **`limitWaitHours`** is 0, 1, 6, 12, or 24 (default 6), set in the Providers sheet.
- **The wait is not a Pi Durable `retry` phase.** It is a nap inside the request. If Pi Durable gets a retry decision hook, the gate can use it for the wait with no change that people can see.
- **Statuses that wait.** When the response's status is known, it decides first: only 408, 429, and 5xx (not 501 or 505) can wait. A 409 waits only when a header gives a reset time (`retry-after`, `retry-after-ms`, or a known reset header). A 403 waits only in a usage limit's own shape, with a reset time. Any other 4xx never waits, whatever its text says.

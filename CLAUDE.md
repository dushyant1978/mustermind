# CLAUDE.md — Mustermind

Standing instructions for any coding session in this repo. Read `HANDOFF.md` next for current state and open decisions.

## What this is

A standalone WebMCP demo for the OpenAI WebMCP Challenge. A wearability decision layer that returns **buy / restyle / wait / skip** with an auditable factor list, over public AJIO product and delivery data.

It runs locally. It does not modify AJIO's web or mobile apps.

**Deadline: 3 September 2026, 1:00 p.m. PT.** The app already works end to end. Everything from here is refinement — prefer a small, verified improvement over a rewrite.

## Stack — do not change without being asked

Dependency-free Node 20 + vanilla HTML/CSS/JS. No build step, no framework, no package manager install, no database.

This is deliberate. It was chosen for a three-day window: nothing to install, nothing to break in CI, and a judge can read the whole thing. If you find yourself wanting React or a bundler, the answer is no.

```
server.js              routes, static file serving, no upstream logic
lib/normalize.js       raw AJIO payload -> ProductTruth
lib/upstream.js        the two AJIO adapters: allowlist, timeouts, cache
lib/verdict.js         the rule engine
lib/state.js           brief, decision ledger, handoff tokens
lib/fixtures.js        demo data, stored in RAW aggregator shape
public/webmcp.js       the five tool registrations
public/store.js        shared client state — UI and agent write to the same place
public/app.js          rendering, and a control fallback for every tool
scripts/selfcheck.js   40 assertions, no framework
```

`lib/*` must stay free of browser globals. `public/*` must stay free of Node APIs.

## Absolute constraints

These are not style preferences. Violating one invalidates the submission.

1. **No anti-bot sensor header. Ever.** Never send, request, print, store, log or commit `X-acf-sensor-data` or any equivalent. If an upstream call only succeeds with one, the correct action is to fall back to fixtures. A grep in the verification step fails if such a string appears anywhere in the tree.
2. **No copied device identifiers.** `ad_id` is a random UUID generated once per process in `lib/upstream.js`.
3. **No cart, checkout, login, orders or payment.** The most this app may ever do is open a product page the user explicitly confirmed.
4. **No arbitrary URL fetching.** Style codes validate against `^[0-9]{6,12}$` plus an allowlist; PIN codes must be six digits. Upstream calls happen server-side only.
5. **Never claim a delivery date the API did not supply.** If the payload has no date, say so. `evaluateWearability` has a branch for exactly this and a test guarding it.
6. **Never present fixture values as live.** Fixture mode is labelled in the banner, the header badge, each card, and in `dataSource` on tool results.
7. **User-facing files stay under `outputs/`.** Scratch work goes in `outputs/work/`.

## Conventions

- ESM throughout (`"type": "module"`).
- Plain functions. No classes, no DI, no factories.
- `lib/verdict.js` is a rule engine on purpose. The agent has to narrate *why* a verdict is what it is; a scorer you cannot read gives it nothing to say. Do not replace it with a model or a weighted-sum black box.
- Every verdict factor carries `source: 'user' | 'product' | 'rules'`. Adding a factor without one breaks the ledger's whole claim.
- Round every number that reaches a screen or a tool result.
- Comment the *why*, not the *what*. The crowd-fit threshold needs a comment; a render loop does not.
- Seller-supplied strings (titles, colours, review text) are untrusted. Run them through `sanitize()` before they reach a tool result. Never interpolate them into a tool description.

## WebMCP specifics

Verified against Chrome's official docs (developer.chrome.com/docs/ai/webmcp, updated 2026-08-20). Earlier drafts of this file got several of these wrong.

- Register via `document.modelContext`, probing `navigator.modelContext` as fallback. Chrome's official examples all use `document`.
- `registerTool` is **awaitable**: `await document.modelContext.registerTool({...})`.
- **`execute` returns a plain string**, not the `{content:[{type:'text'}]}` MCP server envelope. Returning the envelope gets stringified into nonsense the agent has to unwrap. `ok()` in `public/webmcp.js` handles this.
- **Unregistration is via `AbortSignal`** — `registerTool(tool, { signal: controller.signal })`, then `controller.abort()`. There is no `unregisterTool` method.
- `execute` receives `(args, { signal })`. Pass that signal into any long-running fetch.
- Set `annotations: { readOnlyHint, untrustedContentHint }` on every tool. `untrustedContentHint: true` is required on anything returning seller-supplied text.
- The document **must be origin-isolated** or the API is silently absent. `server.js` sends `Origin-Agent-Cluster: ?1` — do not remove it.
- `provideContext()` is not part of Chrome's API. Do not add it.
- Useful for debugging: `await document.modelContext.getTools()` lists what's registered, `executeTool(tool, jsonString)` runs one by hand, and a `toolchange` event fires on `document.modelContext` when the set changes.
- **Cap at five tools.** Tool selection degrades past roughly eight, and five narrow ones is the current design. If you think a sixth is needed, raise it rather than adding it.
- Tool descriptions are load-bearing product surface, not documentation. Each states when to call it, what it returns, what changes state, and when to refuse or ask instead of asserting. Treat description edits as product changes.
- Every state-changing tool must have a visible control equivalent in `public/app.js`, so the demo survives a browser without WebMCP.

## Definition of done for any change

```bash
node scripts/selfcheck.js                                        # must be 0 failures
grep -rniE "acf-sensor|sensor-data|x-acf" . --exclude=README.md   # must return nothing
node --check server.js && for f in lib/*.js public/*.js; do node --check "$f"; done
node server.js                                                   # exercise it by hand
```

Add an assertion for any bug you fix. The suite exists because four real bugs were caught by it during the first build.

## What not to do

- Do not add dependencies, a bundler, or a framework.
- Do not add a sixth tool without asking.
- Do not add search or browse tools — they dilute the entry.
- Do not widen the style-code allowlist by default; that is what `POW_ALLOW_ANY_STYLE=1` is for.
- Do not consult live delivery for a product that came back as a fixture. A fabricated SKU gets a truthful "not serviceable" that says nothing about the garment. `lib/upstream.js` already guards this.
- Do not make wrong-register a soft deduction. It is a hard stop, and that is the single most important product decision in the repo — see HANDOFF.md.

# How Mustermind works

A walkthrough of the whole system, from an HTTP request to a rendered verdict. Read [README.md](README.md) first for what it is and how to run it; this document is the *why it is shaped this way*.

Every file reference is real. If something here disagrees with the code, the code is right and this file is stale — say so.

---

## 1. The one-paragraph version

Mustermind holds a **style brief** (occasion, budget, PIN code, deadline, things you avoid, what you already own). For each candidate garment it fetches **product truth** and **delivery evidence** from two public AJIO endpoints, normalises them into a fixed shape, and runs them through a **rule engine** that emits a decision — `buy`, `restyle`, `wait` or `skip` — plus the list of factors that produced it. Each factor is tagged `user`, `product` or `rules`. Both a human and an agent can read that state and write to it, through the same API, and every write lands in a visible **decision ledger**.

The interesting part is not the scoring. It is that the scoring is legible, that it refuses to claim things the data does not support, and that the agent and the UI are genuinely the same client.

---

## 2. The shape of the thing

```
┌─ browser ─────────────────────────┐
│                                   │
│  public/app.js      UI rendering  │
│  public/webmcp.js   5 WebMCP tools│
│         ↘        ↙                │
│      public/store.js              │  one client state.
│           │                       │  agent writes and human
└───────────┼───────────────────────┘  writes are the same writes
            │  fetch /api/*
┌───────────┼───────────────────────┐
│        server.js                  │  routes only. no upstream logic
│      ↙      ↓        ↘            │
│ lib/state  lib/verdict  lib/upstream
│  brief      the rules    the 2 adapters
│  ledger                    ↓
│  handoffs              lib/normalize
│                        lib/fixtures
└───────────────────────────┼───────┘
                            │ server-side only
                    ┌───────┴────────┐
                    │  AJIO public   │
                    │  PDP · EDD ·   │
                    │  search        │
                    └────────────────┘
```

Two boundaries are enforced by convention and checked by review:

- **`lib/*` never touches a browser global.** It is plain Node, importable by `scripts/selfcheck.js` with no DOM shim.
- **`public/*` never touches a Node API.** It ships to the browser as-is — there is no build step to strip anything.

The browser never calls AJIO. Partly CORS, mostly so the style-code allowlist and the header rules live in exactly one auditable place (`lib/upstream.js`).

---

## 3. What each module owns

| File | Owns | Does not |
|---|---|---|
| `server.js` | Routing, static files, request/response shape | Know anything about AJIO or scoring |
| `lib/upstream.js` | The three AJIO adapters, allowlist, timeouts, cache, fixture fallback | Interpret the data |
| `lib/normalize.js` | Raw payload → `ProductTruth`; sanitising seller strings | Make judgements |
| `lib/verdict.js` | The rule engine and the register tiers | Fetch anything, or know occasion *names* |
| `lib/state.js` | The brief, the occasion registry, the ledger, handoff tokens | Score anything |
| `lib/fixtures.js` | Demo data, stored in **raw aggregator shape** | — |
| `public/store.js` | Client state, one `api()` funnel, in-flight counter | Render |
| `public/app.js` | Rendering, and a visible control for every tool | Talk to AJIO |
| `public/webmcp.js` | The five tool registrations and their descriptions | Hold state |

Fixtures being stored raw matters more than it looks: it means the normaliser runs in fallback mode too. A normaliser that only executes against live data is a normaliser that breaks on its first live call.

---

## 4. Request lifecycle

**On boot** (`server.js` `listen`): log a session-start ledger entry, then `refreshCandidates()` — one AJIO search for the current occasion's query, whose results become the candidate list *and* get added to the style-code allowlist.

**On page load** (`public/app.js` `boot`):

1. `wireEvents()` — every control, including the fallbacks for the state-changing tools.
2. `store.subscribe(render)` — one render function, driven by state, no partial updates.
3. `registerWebMcpTools()` — feature-detects `document.modelContext`, falls back to `navigator.modelContext`, and if neither exists says so in the badge and keeps going.
4. `store.refreshAll()` — `GET /api/brief` and `GET /api/assess` in parallel.

**`GET /api/assess`** is the whole engine in one route:

```
for each candidate style code:
  getProductTruth(code)         → live PDP, or a labelled fixture
  getDeliveryEvidence(sku, pin) → live EDD, skipped if the product was a fixture
  evaluateWearability(product, delivery, brief)
sort by decision (buy, restyle, wait, skip), then by confidence
```

`mode` comes back as `live`, `fixture` or `empty`. `empty` exists because an empty result list is not live data — it means every candidate failed to resolve, and putting a confident "Live AJIO data" badge over a blank screen is a lie.

---

## 5. Trace one verdict end to end

Take AJIO style `702723511` — a polo — with the default brief: a client dinner, ₹3,000, PIN 560029, avoiding slim fits, owning black trousers and a white shirt.

**Fetch.** `getProductTruth('702723511')` checks the code against `^[0-9]{6,12}(_[a-z0-9-]{1,32})?$` and the session allowlist, then calls the PDP aggregator with ordinary app headers and a per-process random `ad_id`. 8-second timeout, 60-second cache. On any failure it returns the bundled fixture with `provenance: 'fixture'` and a note.

**Normalise.** `normalizeProduct()` turns the payload into `ProductTruth`. Four traps it exists to handle:

- Rater counts arrive as display strings — `"2.1K"`, `"1,059"`. `parseRaterCount()` returns `null` on anything it cannot parse, and `null` disables the crowd prior rather than guessing.
- Percentages arrive as `"15 %"`, with a space.
- The size chart is a **superset** of what is purchasable — 8 charted, 5 buyable on this product. Recommendations come from the intersection.
- Crowd fit is matched by attribute *text*, never by array index.

**Score.** `evaluateWearability(product, delivery, brief)` walks four groups in order, pushing a factor for each thing it finds:

```
user constraints  budget · avoided fit · avoided colour
wardrobe          duplicate risk · rewear value
occasion          register (via the tier the occasion resolves to)
product truth     fit confidence · suggested size
delivery          serviceable · in time · or honestly unknown
```

For this polo: within budget `+`, fills a gap `+`, and then — because a client dinner resolves to the **formal** register, and formal lists `Tshirts` in `weakBricks` — *Wrong register*, `-`, weight 4:

> A tshirt does not read as client dinner, whatever it costs — `rules`

**Decide.** The decision block is three tiers, in this order:

1. **Hard stops → `skip`.** Avoided fit, avoided colour, exact duplicate, undeliverable, wrong register, or no wearable size.
2. **Recoverable → `wait`.** Over budget, or arrives after the deadline. Right piece, wrong moment.
3. **Already covered → `restyle`.** Near-duplicate and few looks unlocked.
4. Otherwise → **`buy`**.

The polo hits tier 1 and skips. `confidence` is then a bounded function of the summed positive and negative weights — it describes how lopsided the factor list is, nothing more.

**Render.** The card shows the decision, the headline, and every factor with its source pill. Nothing is hidden behind a score.

### Why wrong register is a hard stop

This is the single most important product decision in the repo. A polo does not become client-dinner appropriate because it is cheap, in stock and deliverable tomorrow. If register were a soft deduction, a sufficiently good price would out-vote it, and the system would confidently recommend something you would be embarrassed to wear. That failure is unrecoverable in a way that "we skipped something you might have liked" is not.

The cost is real: Mustermind will sometimes skip a garment you would happily have worn. That is the trade being made, on purpose.

---

## 6. Occasions and registers

Occasions are **data**; register rules are **code**. The split is what lets the list grow.

- `lib/state.js` owns the registry: `{ id, label, register, query, builtIn }`. Three built-ins ship: client dinner (formal), work (smart casual), weekend (casual).
- `lib/verdict.js` owns `REGISTER_TIERS` — three tiers, each with `preferredBricks` and `weakBricks`. This is the rule content.
- `resolveRegister(brief)` maps `brief.occasion` through `brief.occasions` to a tier. **`verdict.js` never sees an occasion name.**

A shopper adds "Diwali party" and picks the register it reads at. The verdict then hard-stops a tshirt for it, and the ledger can say exactly why — *formal register, which the shopper set*. Nobody hand-wrote a Diwali rule, and nothing was inferred about a festival the system knows nothing about.

Adding one is a `record_user_tradeoff` of type `add_occasion`, or the "+ Add an occasion" control. Both hit `POST /api/tradeoff`, which also re-runs the AJIO search because occasion drives the candidate query.

### Register is not the search query

These are two different questions and conflating them was a real bug. "Goa Trip" added at the default smart-casual register fired **`men formal shirt`**, because the query was derived from the register — and register answers *how dressy*, not *what garment*. A Goa trip and a Sunday brunch are both casual and want completely different clothes.

So the query is inferred from the **label's own words** via `OCCASION_THEMES` in `lib/state.js` — beach/goa/pool → `men beachwear`, manali/winter/ski → `men winter jacket`, gym/workout → `men activewear`, wedding/sangeet → `men festive kurta`. Specific themes are ordered before general ones and the first hit wins, so "Manali trip" reaches winter rather than the generic trip theme. Matching is on whole words, so "training" cannot hit the `rain` theme.

Three things keep the guess honest:

- **It is disclosed.** The note says which query was used and which word triggered it. When nothing matches, the fallback is admitted as broad rather than presented as a choice.
- **It is visible.** The "Find me" field under the occasion dropdown always shows what AJIO is actually being searched for, and `query` is on every occasion in `get_current_style_brief`.
- **It is correctable.** `set_occasion_query` retargets the selected occasion, for the shopper and the agent alike. A guess you cannot override is just a wrong answer you have to live with.

Every query in the table was checked to return live results. One that returns none is worse than a bland one, because `refreshCandidates()` then silently falls back to demo fixtures.

Two fail-safes:

- **An unresolvable register falls back to smart casual**, the only tier with no `weakBricks`. A brief that arrives without a registry therefore cannot manufacture a hard stop out of nothing. Asserted in `scripts/selfcheck.js`.
- **The register is never guessed.** The tool description tells the agent to ask the shopper rather than infer a formality it cannot see, and `add_occasion` rejects a register it does not recognise rather than defaulting quietly.

Labels are sanitised (they reach both the dropdown and the factor prose), slugged to an id, capped, and de-duplicated — re-adding an existing occasion selects it instead of creating a second one, and does not rewrite the register you set the first time.

---

## 7. The wardrobe

Self-reported, and the honest limit on duplicate detection. Two things make it work rather than merely exist:

**Canonicalisation.** `duplicateRisk()` and `looksUnlocked()` compare *exact* category-brick strings, so an item stored as `"trousers"` would sit in the brief looking accepted while influencing no verdict at all. `canonicalBrick()` in `lib/state.js` maps free text onto the five bricks the rules understand — `"chinos"`, `"black formal trousers"` and `"Trousers & Pants"` all land on the same one. Silently-inert input is worse than rejected input.

**Disclosure when it cannot.** Type `"Kurta"` and it is stored, because you do own it — but `recognised: false` comes back, the row is tagged **not scored** in the UI, the tool result marks it `scored: false`, and the response note says in words that it will not move any verdict. The alternative — accepting it silently — makes the wardrobe look more powerful than it is.

Duplicate risk is 1.0 for same category *and* colour (a hard stop), 0.55 for same category only (a near-duplicate, which pushes toward `restyle`). Rewear value counts pairings across the top/bottom split. It does not understand colour theory, formality gradients, or that you might hate the shirt.

### The category taxonomy

`WARDROBE_BRICKS` in `lib/state.js` lists the 15 AJIO bricks the rules can reason about. Every string is AJIO's own, read off live search results rather than invented — `Shorts & 3/4ths` and `Rainwear and Windcheaters` are spelled the way the catalogue spells them.

The taxonomy started at five shirt-family bricks, which was invisible while every query was a shirt query. Once a Goa trip began returning Swimwear and Co-ord Sets, those products fell outside every rule table: no register factor at all, `duplicateRisk` permanently 0, `looksUnlocked` permanently 1. A beachwear list scored mostly `buy` on price and fit alone. For an app whose argument is *recommending nothing when nothing is worth buying*, rubber-stamping a category it cannot reason about is the wrong failure.

The tiers now classify all 15. Three judgement calls worth knowing, because each is arguable:

- **A category may be neutral in a tier.** A coat over formalwear, or a co-ord set at a formal dinner, is in neither `preferredBricks` nor `weakBricks` — no recommendation, no hard stop. Only a claim worth making gets made.
- **An ethnic suit is not a hard stop at a casual occasion**, though a Western suit is. Overdressed for a brunch is not the same as embarrassing, and a hard stop is too strong a claim.
- **`smart-casual` still has no `weakBricks`, and must not gain any.** That is what makes it safe as the fallback register.

Whole outfits — co-ord sets, suit sets, ethnic suits, swimwear — are in neither the tops nor the bottoms list, so they unlock no pairings. That 1 is now the intended answer rather than the default that fell out of an unlisted brick.

**The honest remaining gap:** register expresses formality, not context. Swimwear is a hard stop at a formal occasion and neutral everywhere else — it cannot read as *right* for a Goa trip, because the only tier available is `casual`, and marking swimwear preferred there would make it read right for a Sunday brunch too. Expressing that needs a context axis alongside the formality one, which does not exist.

---

## 8. State, and what does not persist

`lib/state.js` holds three things in memory, single-process, single-user:

- **The brief.** Including the occasion registry and the candidate list.
- **The ledger.** Append-only, capped at 200, every entry carrying an `actor`: `user`, `agent`, `product` or `rules`. This is the audit trail, and it is on screen, not in a log file.
- **Handoff tokens.** Single-use, 60-second TTL, bound to style code + size.

Nothing is written to disk. There is no database, and adding one would only add deploy risk to a demo. `POST /api/reset` restores the default brief, clears the ledger, drops pending handoffs, and revokes every style code the session earned from search.

---

## 9. The two write paths meet in one place

Every state change has exactly two entry points, and they converge immediately:

```
human clicks a control ─┐
                        ├─→ store.applyTradeoff() ─→ POST /api/tradeoff ─→ lib/state.js
agent calls a tool ─────┘                                                      │
                                                    re-score all candidates ←──┘
                                                    write a ledger entry
```

This is why a change the agent makes is visibly on screen a moment later, and why every state-changing tool has a control equivalent in `public/app.js`. The fallback is not a courtesy for old browsers — it is what proves the agent is not a separate, privileged path into the system.

`POST /api/tradeoff` returns `note` whenever a change was accepted but not exactly as asked: a category filed under a different brick, a search query defaulted, an occasion that already existed. The UI shows it under the relevant control; the tool description tells the agent to relay it rather than drop it.

### The handoff gate

`prepare_purchase_handoff` cannot produce a link on its own.

1. Agent calls without `confirmed` → `AWAITING_CONFIRMATION`, and a confirmation card appears on screen.
2. A human clicks it. Only a real DOM click mints a token.
3. Agent calls again with `confirmed: true` and that id → gets the URL.

Guessing an id fails, replaying a used one fails, changing the size after confirmation fails, and an orphaned `undefined` id fails cleanly rather than crashing. All asserted.

Nothing is ever added to a cart. There is no code path to one.

---

## 10. Where the honesty rules are actually enforced

| Rule | Enforced in | Guarded by |
|---|---|---|
| No anti-bot sensor header, ever | `lib/upstream.js` header sets | a grep in the verification step |
| No copied device identifiers | `PROCESS_DEVICE_ID`, random per process | code review |
| No arbitrary URL fetching | `isValidStyleCode` + session allowlist | 5 assertions |
| Never claim a delivery date the API did not supply | `shapeEdd()` returns `etaText: null`; verdict has a branch for it | 2 assertions |
| Missing delivery evidence ≠ deliverable | the `else` branch in the delivery block | 1 assertion |
| Never present fixtures as live | banner, header badge, per-card pill, `dataSource` in tool results | `mode` in `/api/assess` |
| No live delivery lookup for a fixture product | guard in `getDeliveryEvidence` | — |
| Every factor carries a source | `factor()` signature | 1 assertion |
| No factor with empty evidence | `blankToNull()` in the normaliser | 2 assertions |
| Seller strings are untrusted | `sanitize()`, `safeImageUrl()` | 6 assertions |
| A hard stop is never invented | smart-casual fallback in `resolveRegister` | 1 assertion |

The last one about fixtures deserves expanding: **if a product came back as a fixture, the live delivery API is not consulted for it.** A fabricated SKU gets a truthful "not serviceable" from AJIO, which tells you the SKU does not exist rather than anything about the garment. Feeding that into a verdict would put an invented product behind a real-looking hard fail.

---

## 11. The WebMCP surface

Five tools, registered on `document.modelContext`. Three read-only, two that change state. The cap is deliberate — tool selection degrades past roughly eight, and five narrow tools beat eight overlapping ones.

| Tool | State | Purpose |
|---|---|---|
| `get_current_style_brief` | no | The brief everything is scored against, including the valid occasion ids. Call first. |
| `get_product_truth` | no | Price, fabric, fit, per-size cm, live stock, crowd fit, delivery. |
| `evaluate_wearability` | no | The decisions, with factors and sources. |
| `record_user_tradeoff` | **yes** | Applies a constraint the shopper agreed to, re-scores everything. |
| `prepare_purchase_handoff` | **yes** | Two-phase; returns a link only after a human click. |

Some hard-won API details, all verified against Chrome's docs:

- `execute` returns a **plain string**, not the `{content:[{type:'text'}]}` envelope a remote MCP server uses. Returning the envelope gets stringified into nonsense the agent has to unwrap.
- Unregistration is via `AbortSignal` passed at registration. There is no `unregisterTool`.
- The document must be **origin-isolated** or the API is silently absent — `server.js` sends `Origin-Agent-Cluster: ?1` for exactly this reason.
- `provideContext()` is not part of the API.

Tool descriptions are treated as product surface, not documentation. Each says when to call it, what it returns, what it changes, and when to refuse or ask instead of asserting — including "ask the shopper which register rather than guessing".

---

## 12. Changing things safely

```bash
node scripts/selfcheck.js                                        # 135 assertions, must be 0 failures
grep -rniE "acf-sensor|sensor-data|x-acf" . --exclude=README.md   # must return nothing
node --check server.js && for f in lib/*.js public/*.js; do node --check "$f"; done
node server.js                                                   # then exercise it by hand
```

- **Adding a verdict factor:** push it in the right group in `evaluateWearability`, give it a `source`, and decide explicitly whether it belongs in the hard-stop tier. A factor without a source breaks the ledger's whole claim.
- **Adding an occasion:** no code change. That is the point.
- **Adding a register tier:** `REGISTER_TIERS` in `lib/verdict.js`, plus a `REGISTER_QUERY` entry in `lib/state.js` and an `<option>` in the subform.
- **Adding a wardrobe category:** five places, and missing one leaves the category half-known — `WARDROBE_BRICKS` and `BRICK_ALIASES` in `lib/state.js`; `preferredBricks`/`weakBricks` on the tiers it is classified by, the `looksUnlocked` top/bottom split, and `BRICK_SINGULAR` in `lib/verdict.js`; and the datalist in `public/index.html`. Use the real AJIO brick string, not a guess.
- **Adding a tool:** don't, without raising it. Five is the design.

Add an assertion for any bug you fix. The suite exists because four real bugs were caught by it during the first build, and several more since.

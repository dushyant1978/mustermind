# HANDOFF — Mustermind

Current state, decisions already taken, and what to do next. Read `CLAUDE.md` first for the rules.

**Deadline: 3 September 2026, 1:00 p.m. PT.** Roughly three days from the last build.

---

## Where this stands

The app works end to end. `node server.js` → `http://localhost:5173`. `node scripts/selfcheck.js` → 40 assertions, 0 failures.

| Plan step | State |
|---|---|
| 1. Validate live PDP aggregator access | **Blocked — needs you.** See below. |
| 2. Freeze MVP and data model | Done |
| 3. Server-side product-truth adapter | Done — `lib/normalize.js`, `lib/upstream.js` |
| 4. WebMCP tools + Decision Ledger UI | Done — five tools, ledger renders every source |
| 5. Public EDD with safe proxy and cache | Done — 4s timeout, 60s cache, fixture fallback |
| 6. Test locally, record video, submit | Tests done. **Video not started.** |
| 7. Optional AJIO production pilot | Not started, out of scope for the deadline |

### The one thing only you can do

Live aggregator validation could not be run from the environment this was built in — outbound calls with custom headers are restricted there, and the header set is exactly what needs testing. The exact command and a decision table for each outcome are in `README.md` under *Step 1 of your plan*.

Short version: if it returns 403 or a challenge page, **stop and ship on fixtures.** Do not supply a sensor header. The fallback is visible, labelled and demonstrable, and it is a feature you can point at in the video rather than a gap.

---

## Decisions already made — do not silently reverse these

**Wrong register is a hard stop, not a deduction.** The first version ranked a ₹320 polo as the top buy for a client dinner because it was cheap, in stock and not a duplicate. That is the classic failure mode for recommenders. A polo does not become client-dinner appropriate because it is cheap. If you make this a weighted negative again, price will pull junk to the top of the list.

**The opening state has zero buys.** Two restyles, one wait, four skips with four *different* reasons. This is the strongest thing the demo does — a system that recommends nothing when nothing is worth buying is the entire argument. Do not tune the rules to produce a buy on load.

**Fixture products never get live delivery evidence.** A fabricated SKU gets a truthful "not serviceable" from AJIO, which means the SKU does not exist, not that the garment cannot be delivered. Feeding that into a verdict put invented products on real-looking hard fails. Guarded in `lib/upstream.js` via `productProvenance`.

**Fixtures are stored in raw aggregator shape, not pre-normalized.** So the parser runs in fallback mode too. A normalizer that only executes against live data breaks on its first live call.

**Crowd-fit threshold is 6 on the double-weighted score.** `Too Tight`/`Too Loose` count double — they mean a full size off, not a preference. At the rater counts involved (hundreds to thousands) a 6-point weighted gap is several standard errors. This is a dial; it is commented in `lib/normalize.js`. Real verified data (20% tight vs 14% loose over 2,100 raters) sits at 8 and reads as RUNS_SMALL.

---

## Known weaknesses, honestly

Ranked by how likely a judge is to poke at them.

1. **`restyle` fires too easily on a small wardrobe.** Condition is near-duplicate (same category, different colour) plus low rewear. With the two-item default wardrobe that catches most tops. Correct for the default scenario, probably too eager against a fuller one.
2. **Rewear value is crude.** It counts pairings by category. No colour theory, no formality gradient, no notion that you might simply dislike the thing.
3. **Size recommendation is a crowd nudge, not a fit model.** With no purchase history the honest ceiling is "middle of the ladder, moved one step if enough raters say it runs small." It does not claim to know the shopper's body. Stated as a limit in the README — keep it that way.
4. **Occasion rules are a hand-written table** of three occasions in `lib/verdict.js`.
5. **Wardrobe is self-reported**, so duplicate detection is only as good as what was typed.

None of these are hidden in the UI. The factor list shows each contribution.

---

## Next, in priority order

**1. Record the demo video.** Highest value remaining and nothing else is blocking it. The arc is already concrete:

- open on the brief; note nothing is recommended
- walk the four skip reasons — they are four *different* reasons, which is the point
- agent calls `evaluate_wearability`, narrates the factor list with sources visible
- shopper raises the budget; the blazer becomes the single buy, on camera
- `prepare_purchase_handoff` returns `AWAITING_CONFIRMATION`; a human click mints the token; the PDP opens
- close on the ledger, which shows who decided what

Keep it under two minutes. Check the official Devpost rules for the length cap before locking.

**2. Decide the live-vs-fixture question** (see above). It changes one line of the video narration and the header badge.

**3. Write the Devpost submission copy.** Lead with the zero-buys opening state, not with the tool list.

**4. Optional, only if time is left:**
- widen fixtures to 10–12 candidates so the list looks less hand-picked
- tighten the `restyle` condition against a larger wardrobe
- a `looksUnlocked` that understands formality rather than category adjacency

Do not start 4 before 1 is done.

---

## Fast orientation for a new session

```bash
node scripts/selfcheck.js     # 40 assertions — read the names, they document the traps
node server.js                # then open http://localhost:5173
```

The assertion names in `scripts/selfcheck.js` are the fastest description of what this system actually guarantees: that `"2.1K"` is a display string and must disable the crowd prior rather than be guessed at, that the size chart is a superset of what is purchasable, that serviceable-with-no-date is not a delivery claim, that the handoff token rejects guesses and replays.

Verified AJIO field shapes — read off a real PDP — are in `../archive/CONTEXT.fit-studio.superseded.md` §2. That document's product thesis is dead, but §2 and the six corrections in §6 are still accurate and are what `lib/normalize.js` was built from.

# Mustermind

**The wearability agent — buy, restyle, wait or skip, with citations.**

A standalone WebMCP demo. Mustermind is a wearability decision layer that tells you **buy, restyle, wait or skip**, and shows its working — every factor cited by source (you, product facts, or the rules).

It runs entirely on your machine. It does not modify AJIO's web or mobile apps, and it has no access to cart, checkout, login, orders or payment. The most it can ever do is open a product page you explicitly confirmed.

```bash
node server.js          # http://localhost:5173
node scripts/selfcheck.js   # 40 assertions, no test framework
```

Node 20+. No dependencies.

---

## What it does

You give it an occasion, a budget, a PIN code, a date you need something by, fits you avoid, and a rough list of what you already own. It scores candidate garments on four axes — product facts, your constraints, purchase risk, and rewear value — and returns a verdict with the factors behind it.

Every factor is tagged with where it came from: **you**, **product facts**, or **the rules**. That attribution is the point. A recommendation you can't audit is a recommendation you can't argue with.

The default scenario:

> *A client dinner in Bengaluru, under ₹3,000, delivered to 560029. I already own black trousers and a white shirt, and I avoid slim fits.*

Opening state: **nothing is worth buying.** Two candidates are restyles, one is a wait, and four are skipped for four different reasons — wrong register, already owned, avoided fit, undeliverable. Raise the budget to ₹5,500 and the blazer becomes the single buy, because it's the only thing that adds a category the wardrobe doesn't have.

A system that recommends nothing when nothing is worth buying is the whole argument.

---

## Enabling WebMCP in Chrome

**Local development** — no origin trial token needed:

1. `chrome://flags/#enable-webmcp-testing`
2. Set to **Enabled**
3. Relaunch Chrome

Verify in DevTools console: `document.modelContext` should be an object, not `undefined`.

**Production / a hosted demo** — join the [WebMCP origin trial](https://developer.chrome.com/origintrials/#/register_trial/4163014905550602241) (Chrome 149+), then serve the token as a meta tag or HTTP header on every page that registers tools. Not needed for a localhost demo.

**Testing without a full agent** — install the [Model Context Tool Inspector extension](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd). It lists registered tools, calls them manually, validates your JSON Schema, and shows what the tool returned. This is the fastest way to iterate on tool descriptions, and much faster than driving a real agent.

### If the API is missing when the flag is on

WebMCP is only exposed in **origin-isolated documents**. `server.js` sends `Origin-Agent-Cluster: ?1` for exactly this reason. If you proxy this app behind something that strips or overrides that header — or sets `Origin-Agent-Cluster: ?0` — the API disappears with no error and the page silently falls back to manual controls.

It's also gated by the `tools` Permissions Policy, which defaults to `self`. Fine for top-level pages; a cross-origin iframe would need `allow="tools"`.

---

## The five WebMCP tools

Registered via `document.modelContext.registerTool`, with `navigator.modelContext` as a fallback probe. Feature-detected — if neither exists the page stays fully usable and says so.

| Tool | Changes state | What it's for |
|---|---|---|
| `get_current_style_brief` | no | The brief everything else is scored against. Call first. |
| `get_product_truth` | no | Price, fabric, fit, per-size measurements in cm, live stock, crowd fit ratings, delivery. |
| `evaluate_wearability` | no | buy / restyle / wait / skip, with factors and their sources. |
| `record_user_tradeoff` | **yes** | Applies a constraint the shopper agreed to, then re-scores everything. |
| `prepare_purchase_handoff` | **yes** | Two-phase. Returns a PDP link only after a human click. |

### The handoff gate

`prepare_purchase_handoff` cannot produce a link on its own.

1. Agent calls without `confirmed` → returns `AWAITING_CONFIRMATION` and a confirmation card appears on screen.
2. A human clicks it. Only a real DOM click mints a token: single-use, 60-second TTL, bound to session + style code + size.
3. Agent calls again with `confirmed: true` and that id → gets the URL.

Guessing an id fails. Replaying a used one fails. Changing the size after confirmation fails. All four are asserted in `scripts/selfcheck.js`.

Nothing is added to a cart at any point.

---

## Data sources and the live/demo distinction

Two public AJIO sources, both called **server-side only** — the browser never touches them. That is partly CORS and partly so the allowlist and header rules live in one auditable place.

**PDP aggregator** — `pdpaggregator-edge.services.ajio.com/aggregator/pdp/{styleCode}`
Ordinary app headers only: `Accept`, `RequestId`, `X-TENANT-ID`, `client_type`, `client_version`, and an `ad_id` that is a random UUID generated once per process.

**Delivery promise** — `www.ajio.com/api/edd/checkDeliveryDetails`
Only ever reports an ETA the response actually contained. It never infers or invents a date. If the payload has no date, the verdict says *"serviceable, the delivery API did not return a date"* — which is less satisfying and more honest.

### Security rules that are not negotiable

- **No anti-bot sensor header is ever sent, stored, logged or committed.** If a call only succeeds with one, the correct response is to fall back to fixtures, not to supply it. There is a grep in the verification step below that fails the build if such a string appears anywhere in the tree.
- **No arbitrary URL fetching.** Style codes are validated against `^[0-9]{6,12}$` and an allowlist; PIN codes must be six digits.
- **No copied device identifiers.** `ad_id` is generated per process.
- Every upstream call has a 4-second timeout and a 60-second cache. Failure degrades to fixtures; the demo never hangs.

### Fixture labelling

When live data is unavailable the app falls back to bundled fixtures and says so — a banner at the top, a badge in the header, and a `demo data` marker on each affected card. Tool results carry `dataSource: "fixture"`, and the tool descriptions instruct the agent to disclose it if it quotes those numbers.

Fixtures are stored in **raw aggregator shape**, not pre-normalized, so the parser runs in fallback mode too. A normalizer that only executes against live data is a normalizer that breaks on its first live call.

One deliberate behaviour worth knowing: **if a product came back as a fixture, the live delivery API is not consulted for it.** A fabricated SKU gets a truthful "not serviceable" from AJIO, which tells you the SKU doesn't exist rather than anything about the garment. Feeding that into a verdict would put an invented product on a real-looking hard fail.

---

## Step 1 of your plan: validating live aggregator access

I could not run this validation for you — the sandbox this was built in restricts outbound fetches with custom headers, and the correctness of the header set is exactly what needs testing. Run it yourself:

```bash
node -e '
const H = {
  Accept: "application/json",
  RequestId: "ProductDetails",
  "X-TENANT-ID": "AJIO",
  client_type: "Android",
  client_version: "9.9.9",
  ad_id: crypto.randomUUID(),
};
fetch("https://pdpaggregator-edge.services.ajio.com/aggregator/pdp/702723511", { headers: H })
  .then(r => { console.log("status", r.status); return r.text(); })
  .then(t => console.log(t.slice(0, 400)))
  .catch(e => console.log("failed:", e.message));
'
```

Then decide by outcome:

- **200 with JSON** → live access works. Set `POW_ALLOW_ANY_STYLE=1` to widen past the fixture allowlist, and re-run `node server.js`. The badge will read *Live AJIO data*.
- **403 / challenge / HTML** → the edge wants the sensor header. **Stop.** Do not supply one. Ship on fixtures with the banner visible; the demo is complete without live access and the fallback is a feature you can point at in the video.
- **Timeout** → likely network or geo. Retry once, then treat as the 403 case.

Whatever happens, do not commit a captured request. `scripts/selfcheck.js` and the grep below exist to catch it if one slips in.

---

## Verifying

```bash
node scripts/selfcheck.js
grep -rniE "acf-sensor|sensor-data|x-acf" . --exclude=README.md   # must return nothing
```

The 40 assertions cover the parsing traps and the decision rules that the demo depends on:

- `"2.1K"` is a display string, not a number — an unparseable rater count must disable the crowd prior rather than guess
- `"15 %"` has a space before the percent sign
- the size chart is a **superset** of what's purchasable (8 charted, 5 buyable on the real product) — recommendations must come from the intersection
- crowd fit is matched by attribute text, never by array index
- serviceable-with-no-date must not become a delivery claim
- missing delivery evidence must not read as deliverable
- every factor carries a source
- the handoff token rejects guesses, replays, and size swaps

---

## Deploying as a hosted container

Mustermind ships with a `Dockerfile` and a Render Blueprint (`render.yaml`).
The container has **zero npm dependencies** — nothing to install, nothing to
build. The resulting image is under 55 MB.

### One-click Render deploy

1. Push this repo to your GitHub account.
2. In the Render dashboard: **New → Blueprint → connect the `mustermind` repo**.
3. Approve. Render reads `render.yaml`, builds the `Dockerfile`, and boots on
   a free-plan web service at `https://<name>.onrender.com`. The health check
   at `/api/brief` decides readiness.

`autoDeploy: true` in the Blueprint redeploys on every push to `main`. Turn
off if you'd rather deploy manually.

### Local docker

```bash
docker build -t mustermind .
docker run --rm -p 5173:5173 mustermind
# open http://localhost:5173
```

The container reads `$PORT` at runtime (Render, Fly, Cloud Run all inject
it) and falls back to 5173. It runs as a non-root user.

### About the free tier

Render's free plan spins the container down after 15 minutes of inactivity.
The first request after a spin-down takes ~30 seconds while the container
wakes and the initial AJIO search runs. If that's not acceptable for a demo
video, upgrade the `plan:` field in `render.yaml` before deploying.

### Env vars, deliberately minimal

- `PORT` — injected by the platform. No manual setup.
- `NODE_ENV=production` — set in `render.yaml`, decorative here (no deps).
- `POW_ALLOW_ANY_STYLE` — **do not set in production.** The tighter
  invariant is that only codes AJIO's own search returned this session are
  fetchable. `POW_ALLOW_ANY_STYLE=1` is a local escape hatch for testing an
  arbitrary style code (see `lib/upstream.js`).

---

## Layout

```
server.js              routes, static, no upstream logic
lib/normalize.js       raw AJIO payload -> ProductTruth
lib/upstream.js        the two adapters, allowlist, timeouts, cache
lib/verdict.js         the rule engine
lib/state.js           brief, ledger, handoff tokens
lib/fixtures.js        demo data in raw shape
public/webmcp.js       the five tool registrations
public/store.js        shared state — UI and agent write to the same place
public/app.js          rendering and the control fallbacks
scripts/selfcheck.js   48 assertions
Dockerfile             container image, non-root, no build step
render.yaml            Render Blueprint for one-click deploy
```

`lib/verdict.js` is a rule engine on purpose. The agent has to narrate why a verdict is what it is, and a scorer you can't read gives it nothing to say.

---

## Limits worth stating out loud

- **Size recommendation is a crowd nudge, not a fit model.** With no purchase history, the honest ceiling is "the middle of the ladder, moved one step if enough raters say it runs small". It does not claim to know your body.
- **Rewear value is crude.** It counts pairings by category. It does not understand colour theory, formality gradients, or that you might hate the shirt.
- **The wardrobe is self-reported**, so duplicate detection is only as good as what you typed in.
- **Occasion rules are a small hand-written table** in `lib/verdict.js`, covering three occasions.

None of these are hidden in the UI. The factor list shows exactly how much each one contributed.

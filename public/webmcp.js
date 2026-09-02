/**
 * WebMCP tool registration.
 *
 * Uses Chrome's imperative API behind feature detection. `document.modelContext`
 * supersedes `navigator.modelContext`; both are probed so the demo works on
 * either build. `provideContext()` was removed from the spec — do not add it.
 *
 * Five narrow tools. Three read-only, two that change state. The only tool that
 * can produce a purchase link requires an explicit human confirmation first, and
 * nothing here ever mutates a cart.
 */

import { store } from './store.js';

/**
 * WebMCP's `execute` returns a plain string, not the MCP server envelope.
 * Chrome's examples return bare strings and `executeTool()` resolves to one.
 * Returning `{content:[{type:'text',...}]}` here — the shape a remote MCP
 * server uses — gets stringified into nonsense the agent has to unwrap.
 */
const ok = (obj) => JSON.stringify(obj);

/** Compact projection — agents get facts, not our whole view model. */
function briefSummary(brief) {
  return {
    occasion: brief.occasion,
    // The valid set for set_occasion, and it grows at runtime — never assume
    // the three the demo boots with are all there are.
    occasions: (brief.occasions ?? []).map((o) => ({ id: o.id, label: o.label, register: o.register })),
    city: brief.city,
    pinCode: brief.pin,
    budgetINR: brief.budgetINR,
    deadline: brief.deadline,
    avoiding: { fits: brief.avoid.fits, colors: brief.avoid.colors },
    // id is included so remove_wardrobe_item has something to name.
    wardrobe: brief.wardrobe.map((w) => ({
      id: w.id, category: w.category, color: w.color, scored: w.recognised !== false,
    })),
    candidateCount: brief.candidates.length,
  };
}

function productSummary(r) {
  const p = r.product;
  return {
    styleCode: p.styleCode,
    brand: p.brand,
    name: p.name,
    color: p.color,
    imageUrl: p.imageUrl,
    category: p.category.brick,
    priceINR: p.price.currentINR,
    mrpINR: p.price.mrpINR,
    fitType: p.fit.type,
    fabric: p.fit.fabricLabel,
    measurementType: p.measurement.type,
    sizes: p.sizes.map((s) => ({
      size: s.size,
      chestCm: s.garmentCm.chest ?? null,
      waistCm: s.garmentCm.waist ?? null,
      inStock: s.inStock,
      stockLevel: s.stockLevel,
    })),
    crowdFit: p.crowdFit
      ? { verdict: p.crowdFit.verdict, perfectPct: p.crowdFit.perfect, tightPct: p.crowdFit.tight + p.crowdFit.tooTight, loosePct: p.crowdFit.loose + p.crowdFit.tooLoose, raters: p.crowdFit.raters }
      : null,
    delivery: r.delivery
      ? { serviceable: r.delivery.serviceable, eta: r.delivery.etaText, reason: r.delivery.reason }
      : null,
    dataSource: p.provenance,
  };
}

function verdictSummary(r) {
  const v = r.verdict;
  return {
    styleCode: v.styleCode,
    decision: v.decision,
    headline: v.headline,
    confidence: v.confidence,
    recommendedSize: v.recommendedSize,
    sizeRationale: v.sizeRationale,
    duplicateRisk: v.duplicateRisk,
    looksUnlocked: v.looksUnlocked,
    factors: v.factors.map((f) => ({ label: f.label, direction: f.direction, why: f.evidence, source: f.source })),
    // The register the occasion resolved to. A wrong-register decision is a
    // hard stop, so the agent needs to be able to say what it was measured on.
    register: v.register,
    dataSource: v.provenance,
  };
}

const TOOLS = [
  {
    name: 'get_current_style_brief',
    description:
      'Mustermind is a wearability agent for AJIO shoppers. It returns buy / restyle / wait / skip ' +
      'for each candidate garment, and every verdict comes with the factors behind it — each ' +
      'labelled by source: "user" (something the shopper told us), "product" (a fact from AJIO ' +
      'data), or "rules" (Mustermind\'s scoring logic). Always present factors alongside decisions; ' +
      'a bare verdict is not useful. ' +
      'This tool returns the shopper\'s current wearability brief: occasion, city and PIN code, ' +
      'budget in INR, the date they need the item by, fits and colours they are avoiding, and the ' +
      'wardrobe items they already own. It also returns "occasions" — every occasion available to ' +
      'set_occasion, with the register each reads at. That list grows when the shopper adds one, so ' +
      'read it here rather than assuming a fixed set. Wardrobe items marked scored:false are listed ' +
      'but sit outside the categories the rules compare against, so they move no verdict. ' +
      'Call this FIRST in any session — every other tool is ' +
      'scored against this brief, and recommending without it will contradict constraints the ' +
      'shopper already stated. Read only.',
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const s = await store.refreshBrief();
      return ok(briefSummary(s.brief));
    },
  },

  {
    name: 'get_product_truth',
    description:
      'Returns verifiable facts for one candidate garment: price, fabric, fit type, per-size garment ' +
      'measurements in centimetres, live stock per size, how previous buyers rated the fit ' +
      '(perfect/tight/loose and the number of raters), whether it can be delivered to the shopper\'s ' +
      'PIN code, and an imageUrl for the product (safe HTTPS on AJIO\'s asset host) you may cite if ' +
      'the shopper asks to see the item. measurementType tells you how much to trust the numbers: ' +
      '"Garment Measurement" describes the garment itself and is reliable; anything else is weaker. ' +
      'Only sizes listed here are purchasable. If dataSource is "fixture" the values are demo data, ' +
      'not live AJIO values — say so if you quote them. Read only.',
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        styleCode: { type: 'string', description: 'Style code from get_current_style_brief candidates or a verdict result.' },
      },
      required: ['styleCode'],
    },
    async execute({ styleCode }) {
      const r = await store.assessOne(styleCode);
      if (!r?.ok) return ok({ error: `No product truth available for ${styleCode}` });
      return ok(productSummary(r));
    },
  },

  {
    name: 'evaluate_wearability',
    description:
      'The core Mustermind call. Scores candidates against the current brief and returns a decision ' +
      'for each: "buy", "restyle" (the shopper can already assemble this look from what they own), ' +
      '"wait" (right item, wrong price or arrives too late), or "skip" (violates a stated ' +
      'constraint, duplicates something owned, wrong register for the occasion, or cannot be ' +
      'delivered). Every decision comes with its factors, and every factor is cited by source — ' +
      'user, product, or rules. Present the factors alongside the verdict; a bare buy/skip without ' +
      'the reason is not a Mustermind answer. If the whole list scores "skip" or "wait", say so — ' +
      'recommending nothing is a legitimate outcome. Omit styleCode to score every candidate. ' +
      'Read only; changes nothing.',
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        styleCode: { type: 'string', description: 'Optional. Score just this one candidate.' },
      },
    },
    async execute({ styleCode } = {}) {
      if (styleCode) {
        const r = await store.assessOne(styleCode);
        if (!r?.ok) return ok({ error: `No candidate found for ${styleCode}` });
        return ok({ results: [verdictSummary(r)] });
      }
      const s = await store.refreshAll();
      return ok({
        mode: s.mode,
        results: s.results.map(verdictSummary),
      });
    },
  },

  {
    name: 'record_user_tradeoff',
    description:
      'Records a change the shopper has agreed to and re-scores every candidate against it. Use ' +
      'this when they relax or tighten a constraint — "I could stretch to 4000", "actually slim ' +
      'fit is fine", "I need it by Friday", "I also own a navy blazer", "make it a weekend brief". ' +
      'Use add_occasion when they name an occasion that is not already in the brief\'s occasions ' +
      'list ("it\'s for a Diwali party"): you must supply the register it reads at — "formal", ' +
      '"smart-casual" or "casual" — because that is what decides whether a garment is a hard stop ' +
      'for it. Ask the shopper which one rather than guessing at a formality you cannot see. ' +
      'Changing or adding an occasion also refreshes the live candidate list from AJIO search. ' +
      'CHANGES STATE: only call it after the shopper has actually said so, never to explore a ' +
      'hypothetical. The change is written to Mustermind\'s Decision Ledger under actor "agent" ' +
      'and is visible to the shopper. Returns the updated verdicts, and a "note" whenever the ' +
      'change was accepted but not exactly as asked — relay the note, do not drop it.',
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['set_budget', 'avoid_fit', 'allow_fit', 'avoid_color', 'set_deadline', 'set_pin', 'set_occasion', 'add_occasion', 'add_wardrobe_item', 'remove_wardrobe_item'],
          description: 'Which constraint to change.',
        },
        value: {
          description: 'Number for set_budget. Text for fits/colours. YYYY-MM-DD for set_deadline. '
            + '6 digits for set_pin. An occasion id from the brief\'s occasions list for set_occasion. '
            + 'Object {label, register, query} for add_occasion — register is formal | smart-casual | casual, '
            + 'query is an optional AJIO search phrase and defaults to the register\'s. '
            + 'Object {category, color} for add_wardrobe_item — category is free text and is filed under the '
            + 'nearest scored category where one matches. The wardrobe item id for remove_wardrobe_item.',
        },
      },
      required: ['type', 'value'],
    },
    async execute({ type, value }) {
      const r = await store.applyTradeoff({ type, value, actor: 'agent' });
      if (!r.ok) return ok({ error: r.error });
      return ok({
        applied: r.summary,
        changed: r.changed,
        note: r.note ?? undefined,
        brief: briefSummary(r.brief),
        results: r.results.map(verdictSummary),
      });
    },
  },

  {
    name: 'prepare_purchase_handoff',
    description:
      'Mustermind\'s two-phase handoff to a product page. It never adds to cart, never checks out, ' +
      'and never spends money — the most it can do is return a link the shopper asked for. ' +
      'Call it WITHOUT confirmed to request a handoff: it returns AWAITING_CONFIRMATION and a ' +
      'confirmation card appears on screen for the shopper to click. Only after they click, and ' +
      'only if they tell you they did, call again with confirmed:true and the same confirmationId ' +
      'to get the URL. Never set confirmed:true on your own initiative, and never guess a ' +
      'confirmationId — a token is only issued by a real DOM click and expires in 60 seconds. ' +
      'Only call this for candidates whose verdict is "buy" or "restyle"; for "wait" or "skip", ' +
      'explain why and stop.',
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        styleCode: { type: 'string' },
        size: { type: 'string', description: 'Optional. Defaults to the recommended size.' },
        confirmed: { type: 'boolean', description: 'Only true after the shopper has clicked confirm.' },
        confirmationId: { type: 'string', description: 'The id returned by the unconfirmed call.' },
      },
      required: ['styleCode'],
    },
    async execute({ styleCode, size, confirmed, confirmationId }) {
      if (!confirmed) {
        const r = await store.prepareHandoff(styleCode, size);
        if (!r.ok) return ok({ error: r.error });
        return ok({
          status: 'AWAITING_CONFIRMATION',
          confirmationId: r.confirmationId,
          item: r.item,
          expiresInSeconds: r.expiresInSeconds,
          next: 'A confirmation card is now on screen. Ask the shopper to click it, then call again with confirmed:true and this confirmationId.',
          note: r.note,
        });
      }
      const r = await store.confirmHandoff(confirmationId, styleCode, size);
      if (!r.ok) return ok({ error: r.error, hint: 'The shopper must click the confirmation card first.' });
      return ok({ status: 'READY', pdpUrl: r.pdpUrl, styleCode: r.styleCode, size: r.size, note: 'Opens the product page. Nothing has been purchased.' });
    },
  },
];

/**
 * Registers all five tools. Returns an object with an `unregister()` that
 * aborts the controller — Chrome removes tools via AbortSignal passed at
 * registration, not via a separate unregisterTool call.
 */
export async function registerWebMcpTools() {
  const mc = document.modelContext ?? navigator.modelContext ?? null;
  if (!mc || typeof mc.registerTool !== 'function') {
    return { available: false, tools: TOOLS.map((t) => t.name), unregister() {} };
  }

  const controller = new AbortController();
  const registered = [];

  for (const tool of TOOLS) {
    try {
      await mc.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: async (args, opts) => {
          store.noteToolCall(tool.name, args);
          try {
            return await tool.execute(args ?? {}, opts ?? {});
          } catch (err) {
            return ok({ error: String(err?.message ?? err) });
          }
        },
      }, { signal: controller.signal });
      registered.push(tool.name);
    } catch (err) {
      console.warn(`Could not register ${tool.name}:`, err);
    }
  }

  return {
    available: registered.length > 0,
    tools: registered,
    unregister: () => controller.abort(),
  };
}

export { TOOLS };

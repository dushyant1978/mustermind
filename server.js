/**
 * Mustermind — local demo server. Dependency-free.
 *
 * Serves the UI and a small API. All upstream AJIO access happens here, never
 * in the browser: the endpoints need ordinary app headers that CORS would block
 * from page context, and keeping them server-side is also what lets us enforce
 * the style-code allowlist and the no-sensor-header rule in one place.
 *
 * This server never touches cart, checkout, login, orders or payment.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProductTruth, getDeliveryEvidence, isValidPin } from './lib/upstream.js';
import { evaluateWearability } from './lib/verdict.js';
import { state, logDecision, applyTradeoff, resetSession, createHandoff, consumeHandoff, refreshCandidates } from './lib/state.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
};

async function readBody(req, limit = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid JSON body'); }
}

/** Product truth + delivery evidence + verdict for one style code. */
async function assess(styleCode, brief) {
  const p = await getProductTruth(styleCode);
  if (!p.ok) return { ok: false, styleCode, error: p.error };

  const product = p.product;
  const sku = product.sizes?.[0]?.sku ?? styleCode;

  let delivery = null;
  let deliveryNote = null;
  if (isValidPin(brief.pin)) {
    const d = await getDeliveryEvidence(sku, brief.pin, { styleCode, productProvenance: product.provenance });
    if (d.ok) { delivery = d.delivery; deliveryNote = d.note; }
  }

  const verdict = evaluateWearability(product, delivery, brief);
  return {
    ok: true,
    styleCode,
    product,
    delivery,
    verdict,
    notes: [p.note, deliveryNote].filter(Boolean),
  };
}

async function assessAll(brief) {
  const results = await Promise.all((brief.candidates ?? []).map((c) => assess(c, brief)));
  const order = { buy: 0, restyle: 1, wait: 2, skip: 3 };
  return results
    .filter((r) => r.ok)
    .sort((a, b) => {
      const d = order[a.verdict.decision] - order[b.verdict.decision];
      return d !== 0 ? d : b.verdict.confidence - a.verdict.confidence;
    });
}

const routes = {
  'GET /api/brief': async (_req, res) => {
    json(res, 200, { brief: state.brief, ledger: state.ledger });
  },

  'GET /api/assess': async (req, res, url) => {
    const styleCode = url.searchParams.get('styleCode');
    if (styleCode) {
      const r = await assess(styleCode, state.brief);
      return json(res, r.ok ? 200 : 404, r);
    }
    const results = await assessAll(state.brief);
    const anyFixture = results.some((r) => r.product.provenance === 'fixture');
    json(res, 200, { results, mode: anyFixture ? 'fixture' : 'live' });
  },

  'POST /api/tradeoff': async (req, res) => {
    const body = await readBody(req);
    const result = applyTradeoff(body);
    if (!result.ok) return json(res, 400, result);

    if (result.changed) {
      logDecision({
        actor: body.actor === 'agent' ? 'agent' : 'user',
        kind: 'tradeoff',
        summary: result.summary,
        detail: { type: body.type, value: body.value },
      });
      // Occasion drives OCCASION_QUERY (search) and OCCASION_RULES (scoring),
      // so a real change should refresh the candidate list from live search.
      if (body.type === 'set_occasion') await refreshCandidates();
    }

    const results = await assessAll(state.brief);
    json(res, 200, { ok: true, changed: result.changed, summary: result.summary, brief: state.brief, results, ledger: state.ledger });
  },

  'POST /api/handoff/prepare': async (req, res) => {
    const { styleCode, size } = await readBody(req);
    const r = await assess(styleCode, state.brief);
    if (!r.ok) return json(res, 404, { ok: false, error: 'unknown style code' });

    const chosen = size ?? r.verdict.recommendedSize;
    const variant = (r.product.sizes ?? []).find((s) => s.size === chosen);
    if (!variant) return json(res, 400, { ok: false, error: `size ${chosen} is not available` });

    const id = createHandoff({ styleCode, size: chosen, pdpUrl: r.product.pdpUrl });
    logDecision({
      actor: 'agent',
      kind: 'handoff-requested',
      summary: `Asked to open ${r.product.brand} ${r.product.name} in size ${chosen}`,
      detail: { styleCode, size: chosen },
    });

    json(res, 200, {
      ok: true,
      status: 'AWAITING_CONFIRMATION',
      confirmationId: id,
      expiresInSeconds: 60,
      item: { styleCode, size: chosen, brand: r.product.brand, name: r.product.name, priceINR: r.product.price?.currentINR },
      note: 'This opens the product page. It does not add to cart or purchase anything.',
    });
  },

  'POST /api/handoff/confirm': async (req, res) => {
    const { confirmationId, styleCode, size } = await readBody(req);
    const r = consumeHandoff(confirmationId, { styleCode, size });
    if (!r.ok) return json(res, 400, r);

    logDecision({
      actor: 'user',
      kind: 'handoff-confirmed',
      summary: `Confirmed opening the product page for ${styleCode} in size ${size}`,
      detail: { styleCode, size },
    });

    json(res, 200, { ok: true, pdpUrl: r.handoff.pdpUrl, styleCode, size });
  },

  'POST /api/reset': async (_req, res) => {
    resetSession();
    await refreshCandidates();
    const results = await assessAll(state.brief);
    json(res, 200, { ok: true, brief: state.brief, results, ledger: state.ledger });
  },

  'POST /api/ledger': async (req, res) => {
    const { actor, kind, summary, detail } = await readBody(req);
    if (!summary) return json(res, 400, { ok: false, error: 'summary is required' });
    const allowed = ['user', 'agent', 'product', 'rules'];
    const entry = logDecision({
      actor: allowed.includes(actor) ? actor : 'agent',
      kind: String(kind ?? 'note').slice(0, 40),
      summary: String(summary).slice(0, 200),
      detail: detail ?? null,
    });
    json(res, 200, { ok: true, entry, ledger: state.ledger });
  },
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // WebMCP is only exposed in origin-isolated documents. Without this the
      // API is silently absent and the page falls back to manual controls for
      // no visible reason.
      'Origin-Agent-Cluster': '?1',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    const handler = routes[key];
    if (handler) return await handler(req, res, url);
    if (req.method === 'GET') return await serveStatic(req, res, url.pathname);
    json(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

server.listen(PORT, async () => {
  logDecision({ actor: 'rules', kind: 'session', summary: 'Session started with the demo style brief' });
  console.log(`Mustermind running at http://localhost:${PORT}`);
  console.log('Upstream AJIO calls are server-side only. No sensor headers are sent.');
  console.log('If a live call fails the UI falls back to clearly-labelled demo data.');
  const r = await refreshCandidates();
  console.log(r.ok
    ? `Loaded ${r.count} live candidates for query "${r.query}"`
    : `Search unavailable (${r.error}); serving demo candidates`);
});

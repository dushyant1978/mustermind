/**
 * UI layer. Renders from the shared store, so a change made by the agent and a
 * change made by hand land in exactly the same place.
 *
 * When WebMCP is unavailable the page stays fully usable — every tool has a
 * visible control equivalent.
 */

import { store } from './store.js';
import { registerWebMcpTools, TOOLS } from './webmcp.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inr = (n) => (typeof n === 'number' ? `₹${n.toLocaleString('en-IN')}` : '—');

const DIR_CLASS = { '+': 'dir-plus', '-': 'dir-minus', '0': 'dir-zero' };
const DIR_GLYPH = { '+': '+', '-': '−', '0': '·' };

function renderBrief(s) {
  if (!s.brief) return;
  const b = s.brief;
  if ($('occasion').value !== b.occasion) $('occasion').value = b.occasion;
  if (document.activeElement !== $('budget')) $('budget').value = b.budgetINR ?? '';
  if (document.activeElement !== $('pin')) $('pin').value = b.pin ?? '';
  if (document.activeElement !== $('deadline')) $('deadline').value = b.deadline ?? '';

  $('avoid-list').innerHTML = [
    ...b.avoid.fits.map((f) => ({ kind: 'fit', v: f })),
    ...b.avoid.colors.map((c) => ({ kind: 'color', v: c })),
  ].map(({ kind, v }) =>
    `<span class="chip">${esc(v)}<button type="button" data-remove-kind="${kind}" data-remove="${esc(v)}" aria-label="Stop avoiding ${esc(v)}">&times;</button></span>`
  ).join('');

  $('wardrobe').innerHTML = b.wardrobe.length
    ? b.wardrobe.map((w) =>
      `<li><span>${esc(w.descriptor || w.category)}</span><span class="cat">${esc(w.category)}</span></li>`).join('')
    : '<li><span class="cat">Nothing listed</span></li>';
}

function renderResults(s) {
  const el = $('results');
  if (!s.results.length) {
    el.innerHTML = '<div class="empty">No candidates yet.</div>';
    return;
  }

  const counts = s.results.reduce((a, r) => {
    a[r.verdict.decision] = (a[r.verdict.decision] ?? 0) + 1;
    return a;
  }, {});
  $('result-count').textContent = ['buy', 'restyle', 'wait', 'skip']
    .filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(' · ');

  el.innerHTML = s.results.map((r) => {
    const v = r.verdict;
    const p = r.product;
    const canHandoff = v.decision === 'buy' || v.decision === 'restyle';

    // p.imageUrl is already URL-validated in lib/normalize.js (HTTPS + assets.ajio.com).
    // esc() still runs for defence in depth against future changes upstream.
    const thumb = p.imageUrl
      ? `<img class="verdict-thumb" src="${esc(p.imageUrl)}" alt="${esc(p.brand ?? '')} ${esc(p.name ?? '')}" loading="lazy" referrerpolicy="no-referrer" />`
      : `<div class="verdict-thumb verdict-thumb-empty" aria-hidden="true"></div>`;

    return `
    <article class="verdict">
      <div class="verdict-head">
        ${thumb}
        <span class="decision d-${v.decision}">${v.decision}</span>
        <div class="verdict-title">
          <div class="name">${esc(p.brand ?? '')} — ${esc(p.name ?? '')}</div>
          <div class="meta">${esc(p.color ?? '')} · ${esc(p.category?.brick ?? '')} · ${esc(p.fit?.type ?? '')}${p.provenance === 'fixture' ? ' · demo data' : ''}</div>
          <div class="headline">${esc(v.headline)}</div>
        </div>
        <div class="price">${inr(p.price?.currentINR)}
          ${p.price?.mrpINR ? `<span class="mrp">${inr(p.price.mrpINR)}</span>` : ''}
        </div>
      </div>

      <ul class="factors">
        ${v.factors.map((f) => `
          <li>
            <span class="dir ${DIR_CLASS[f.direction]}">${DIR_GLYPH[f.direction]}</span>
            <span><span>${esc(f.label)}</span><br /><span class="factor-why">${esc(f.evidence)}</span></span>
            <span class="source">${esc(f.source)}</span>
          </li>`).join('')}
      </ul>

      <div class="verdict-foot">
        <span class="size-line">
          ${v.recommendedSize ? `Suggested size <strong>${esc(v.recommendedSize)}</strong>` : 'No wearable size'}
          · ${v.looksUnlocked} look${v.looksUnlocked === 1 ? '' : 's'} unlocked
        </span>
        ${canHandoff
        ? `<button class="btn" type="button" data-handoff="${esc(r.styleCode)}" data-size="${esc(v.recommendedSize ?? '')}">Open product page</button>`
        : ''}
      </div>
    </article>`;
  }).join('');
}

function renderLedger(s) {
  $('ledger').innerHTML = s.ledger.length
    ? [...s.ledger].reverse().map((e) => `
      <li>
        <span class="actor a-${esc(e.actor)}">${esc(e.actor)}</span>
        <span>${esc(e.summary)}<span class="when">${new Date(e.at).toLocaleTimeString()}</span></span>
      </li>`).join('')
    : '<li><span class="actor a-rules">rules</span><span>Nothing recorded yet</span></li>';
}

function renderToolCalls(s) {
  $('tool-calls').innerHTML = s.toolCalls.map((c) => {
    const args = Object.keys(c.args).length ? ` ${JSON.stringify(c.args)}` : '';
    return `<li title="${esc(c.name + args)}">${esc(c.name)}${esc(args)}</li>`;
  }).join('');
}

function renderMode(s) {
  const fixture = s.results.some((r) => r.product.provenance === 'fixture');
  const badge = $('mode-badge');
  badge.textContent = fixture ? 'Demo data' : 'Live AJIO data';
  badge.className = `badge ${fixture ? 'badge-warn' : 'badge-ok'}`;
  $('fixture-banner').hidden = !fixture;

  if (fixture) {
    const notes = [...new Set(s.results.flatMap((r) => r.notes ?? []))];
    // Notes are self-describing ("Demo data. why."). The banner already carries
    // a static "Demo data." label, so strip the prefix to avoid it repeating.
    const detail = (notes[0] ?? '').replace(/^Demo data\.\s*/, '');
    if (detail) $('fixture-detail').textContent = `${detail} These are not live AJIO values.`;
  }
}

function renderHandoff(s) {
  const layer = $('handoff-layer');
  const h = s.pendingHandoff;
  if (!h) { layer.hidden = true; return; }
  layer.hidden = false;
  $('handoff-item').textContent =
    `${h.item.brand} — ${h.item.name}, size ${h.item.size}${h.item.priceINR ? `, ${inr(h.item.priceINR)}` : ''}`;
  $('handoff-expiry').textContent = `This confirmation expires in ${h.expiresInSeconds} seconds.`;
}

function render(s) {
  renderBrief(s);
  renderResults(s);
  renderLedger(s);
  renderToolCalls(s);
  renderMode(s);
  renderHandoff(s);
}

function wireEvents() {
  $('occasion').addEventListener('change', (e) => {
    store.applyTradeoff({ type: 'set_occasion', value: e.target.value });
  });

  const debounce = (fn, ms = 450) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  $('budget').addEventListener('input', debounce((e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v > 0) store.applyTradeoff({ type: 'set_budget', value: v });
  }));

  $('pin').addEventListener('input', debounce((e) => {
    const v = e.target.value.trim();
    if (/^[1-9][0-9]{5}$/.test(v)) store.applyTradeoff({ type: 'set_pin', value: v });
  }));

  $('deadline').addEventListener('change', (e) => {
    if (e.target.value) store.applyTradeoff({ type: 'set_deadline', value: e.target.value });
  });

  $('avoid-add').addEventListener('click', () => {
    const v = $('avoid-input').value.trim();
    if (!v) return;
    store.applyTradeoff({ type: 'avoid_fit', value: v }).then(() => { $('avoid-input').value = ''; });
  });

  $('avoid-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const type = btn.dataset.removeKind === 'color' ? 'avoid_color' : 'allow_fit';
    if (type === 'allow_fit') store.applyTradeoff({ type, value: btn.dataset.remove });
  });

  $('results').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-handoff]');
    if (!btn) return;
    store.prepareHandoff(btn.dataset.handoff, btn.dataset.size || undefined);
  });

  $('handoff-confirm').addEventListener('click', async () => {
    // A click without a pending prepare would send confirmationId:undefined
    // and surface a confusing "no such confirmation" to the shopper. Belt-and-
    // braces alongside the .handoff-layer[hidden] rule in styles.css.
    if (!store.pendingHandoff) return;
    const r = await store.confirmHandoff();
    if (r?.ok && r.pdpUrl) window.open(r.pdpUrl, '_blank', 'noopener');
    else if (r?.error) alert(r.error);
  });

  $('handoff-cancel').addEventListener('click', () => store.clearHandoff());

  $('reset').addEventListener('click', () => store.reset());
}

async function boot() {
  wireEvents();
  store.subscribe(render);

  const mcp = await registerWebMcpTools();
  store.webmcp = mcp;

  const badge = $('mcp-badge');
  if (mcp.available) {
    badge.textContent = `WebMCP · ${mcp.tools.length} tools`;
    badge.className = 'badge badge-ok';
    $('mcp-note').textContent =
      'This page has registered its tools. Ask the agent about the brief, the candidates, or a tradeoff — calls appear below.';
  } else {
    badge.textContent = 'WebMCP unavailable';
    badge.className = 'badge badge-muted';
    $('mcp-note').textContent =
      `No document.modelContext in this browser, so the ${TOOLS.length} tools are not registered. `
      + 'Every one of them has a control on this page, so the demo still works — enable the WebMCP flag in Chrome to drive it by agent.';
  }

  await store.refreshAll();
}

boot();

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

  // The occasion list is state, not markup — a shopper or the agent can add to
  // it. Rebuild only when the set actually changed, so an open dropdown isn't
  // yanked out from under the pointer on every unrelated re-render.
  const sel = $('occasion');
  const wanted = (b.occasions ?? []).map((o) => o.id).join('|');
  if (sel.dataset.ids !== wanted) {
    sel.innerHTML = (b.occasions ?? []).map((o) =>
      `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    sel.dataset.ids = wanted;
  }
  if (sel.value !== b.occasion) sel.value = b.occasion;

  // Don't clobber it mid-type; otherwise show what the candidate list came from.
  const active = (b.occasions ?? []).find((o) => o.id === b.occasion);
  if (document.activeElement !== $('occasion-q')) $('occasion-q').value = active?.query ?? '';
  if (document.activeElement !== $('budget')) $('budget').value = b.budgetINR ?? '';
  if (document.activeElement !== $('pin')) $('pin').value = b.pin ?? '';
  if (document.activeElement !== $('deadline')) $('deadline').value = b.deadline ?? '';

  $('avoid-list').innerHTML = [
    ...b.avoid.fits.map((f) => ({ kind: 'fit', v: f })),
    ...b.avoid.colors.map((c) => ({ kind: 'color', v: c })),
  ].map(({ kind, v }) =>
    `<span class="chip">${esc(v)}<button type="button" data-remove-kind="${kind}" data-remove="${esc(v)}" aria-label="Stop avoiding ${esc(v)}">&times;</button></span>`
  ).join('');

  // recognised === false means the category matched none of the bricks the
  // rules compare against. Marked, because an item that silently moves no
  // verdict while sitting in the list is the confusing outcome.
  $('wardrobe').innerHTML = b.wardrobe.length
    ? b.wardrobe.map((w) => `
      <li>
        <span>${esc(w.descriptor || w.category)}</span>
        <span class="cat">${w.recognised === false
          ? '<span class="unscored" title="Outside the categories duplicate and rewear scoring covers">not scored</span>'
          : esc(w.category)}</span>
        <button type="button" class="chip-x" data-remove-wardrobe="${esc(w.id)}" aria-label="Remove ${esc(w.descriptor || w.category)}">&times;</button>
      </li>`).join('')
    : '<li><span class="cat">Nothing listed</span></li>';
}

/** Transient one-line feedback under a subform. Cleared by the next action. */
function showNote(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text ?? '';
  el.hidden = !text;
}

const SKELETON_CARD = `
  <div class="skeleton" aria-hidden="true">
    <div class="skeleton-thumb"></div>
    <div class="skeleton-body">
      <div class="skeleton-row w-30"></div>
      <div class="skeleton-row w-70"></div>
      <div class="skeleton-row w-50"></div>
      <div class="skeleton-row w-40"></div>
    </div>
    <div class="skeleton-body">
      <div class="skeleton-row w-80"></div>
    </div>
  </div>`;

function renderResults(s) {
  const el = $('results');
  // Initial load: no results yet AND something is in flight. Skeletons keep
  // the layout height stable so the ledger and tool-call panels don't jump
  // when the real cards land.
  if (s.results.length === 0 && s.loading > 0) {
    el.innerHTML = SKELETON_CARD.repeat(4);
    $('result-count').textContent = 'loading…';
    return;
  }
  if (!s.results.length) {
    el.innerHTML = '<div class="empty">No candidates yet.</div>';
    $('result-count').textContent = '';
    return;
  }

  const counts = s.results.reduce((a, r) => {
    a[r.verdict.decision] = (a[r.verdict.decision] ?? 0) + 1;
    return a;
  }, {});
  const summary = ['buy', 'restyle', 'wait', 'skip']
    .filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(' · ');
  // If results are showing AND a fetch is in flight, we're recomputing —
  // the existing cards are stale for a moment. Say so instead of pretending.
  $('result-count').textContent = s.loading > 0 ? `${summary} · recomputing…` : summary;

  el.innerHTML = s.results.map((r) => {
    const v = r.verdict;
    const p = r.product;
    const canHandoff = v.decision === 'buy' || v.decision === 'restyle';

    // p.imageUrl is already URL-validated in lib/normalize.js (HTTPS + assets.ajio.com).
    // esc() still runs for defence in depth against future changes upstream.
    const thumb = p.imageUrl
      ? `<img class="verdict-thumb" src="${esc(p.imageUrl)}" alt="${esc(p.brand ?? '')} ${esc(p.name ?? '')}" loading="lazy" referrerpolicy="no-referrer" />`
      : `<div class="verdict-thumb verdict-thumb-empty" aria-hidden="true"></div>`;
    const metaBits = [p.color, p.category?.brick, p.fit?.type].filter(Boolean).map(esc).join(' · ');
    const provenancePill = p.provenance === 'fixture'
      ? '<span class="pill pill-demo">demo</span>'
      : '<span class="pill pill-live">live</span>';

    return `
    <article class="verdict">
      <div class="verdict-head">
        ${thumb}
        <div class="verdict-title">
          <span class="decision d-${v.decision}">${v.decision}</span>
          <div class="brand-line">${esc(p.brand ?? '')}</div>
          <div class="name">${esc(p.name ?? '')}</div>
          <div class="meta">${metaBits} ${provenancePill}</div>
          <div class="headline">${esc(v.headline)}</div>
        </div>
        <div class="price">
          <span class="amount">${inr(p.price?.currentINR)}</span>
          ${p.price?.mrpINR ? `<span class="mrp">${inr(p.price.mrpINR)}</span>` : ''}
        </div>
      </div>

      <ul class="factors">
        ${v.factors.map((f) => `
          <li>
            <span class="dir ${DIR_CLASS[f.direction]}">${DIR_GLYPH[f.direction]}</span>
            <span><span>${esc(f.label)}</span><br /><span class="factor-why">${esc(f.evidence)}</span></span>
            <span class="source source-${esc(f.source)}">${esc(f.source)}</span>
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

// Anti-flicker on the top progress bar. Fast fetches (< 100ms) never show
// the bar; back-to-back sequential fetches keep it visible across the gap.
const progressTimers = { show: null, hide: null };
function renderProgress(s) {
  const p = $('progress');
  if (!p) return;
  clearTimeout(progressTimers.show); clearTimeout(progressTimers.hide);
  if (s.loading > 0) {
    progressTimers.show = setTimeout(() => { p.hidden = false; }, 100);
  } else {
    progressTimers.hide = setTimeout(() => { p.hidden = true; }, 150);
  }
}

function render(s) {
  renderProgress(s);
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

  // --- add an occasion ----------------------------------------------------
  const occasionForm = (open) => {
    $('occasion-form').hidden = !open;
    $('occasion-toggle').setAttribute('aria-expanded', String(open));
    showNote('occasion-error', null);
    if (open) $('occasion-label').focus();
  };

  const applyQuery = async () => {
    const q = $('occasion-q').value.trim();
    if (!q) return showNote('occasion-q-note', 'Give it something to search for.');
    showNote('occasion-q-note', null);
    const r = await store.applyTradeoff({ type: 'set_occasion_query', value: q });
    if (!r.ok) showNote('occasion-q-note', r.error);
  };
  $('occasion-q-apply').addEventListener('click', applyQuery);
  $('occasion-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyQuery(); }
  });

  $('occasion-toggle').addEventListener('click', () => occasionForm($('occasion-form').hidden));
  $('occasion-cancel').addEventListener('click', () => {
    $('occasion-label').value = '';
    $('occasion-query').value = '';
    occasionForm(false);
  });

  $('occasion-add').addEventListener('click', async () => {
    const label = $('occasion-label').value.trim();
    if (!label) return showNote('occasion-error', 'Give the occasion a name.');
    const r = await store.applyTradeoff({
      type: 'add_occasion',
      value: { label, register: $('occasion-register').value, query: $('occasion-query').value.trim() || undefined },
    });
    if (!r.ok) return showNote('occasion-error', r.error);
    $('occasion-label').value = '';
    $('occasion-query').value = '';
    occasionForm(false);
    // The note says which query was inferred and what it matched on. That is
    // the one thing the shopper most needs to see about a new occasion.
    showNote('occasion-q-note', r.note ?? null);
  });

  // Enter in the label field is the obvious way to submit a two-field form.
  $('occasion-label').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('occasion-add').click(); }
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

  // --- wardrobe -----------------------------------------------------------
  const addWardrobeItem = async () => {
    const category = $('wardrobe-cat').value.trim();
    if (!category) return showNote('wardrobe-note', 'Name a category you own, e.g. Jeans.');
    const r = await store.applyTradeoff({
      type: 'add_wardrobe_item',
      value: { category, color: $('wardrobe-color').value.trim() },
    });
    if (!r.ok) return showNote('wardrobe-note', r.error);
    $('wardrobe-cat').value = '';
    $('wardrobe-color').value = '';
    // r.note explains anything the server did differently from what was typed
    // — a category filed under a different brick, or one it cannot score.
    showNote('wardrobe-note', r.note ?? (r.changed ? null : r.summary));
  };

  $('wardrobe-add').addEventListener('click', addWardrobeItem);
  for (const id of ['wardrobe-cat', 'wardrobe-color']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addWardrobeItem(); }
    });
  }

  $('wardrobe').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove-wardrobe]');
    if (!btn) return;
    showNote('wardrobe-note', null);
    const r = await store.applyTradeoff({ type: 'remove_wardrobe_item', value: btn.dataset.removeWardrobe });
    if (!r.ok) showNote('wardrobe-note', r.error);
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

  $('reset').addEventListener('click', () => {
    showNote('wardrobe-note', null);
    showNote('occasion-error', null);
    showNote('occasion-q-note', null);
    store.reset();
  });
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

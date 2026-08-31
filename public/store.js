/**
 * Client-side state. Single source of truth shared by the UI and the WebMCP
 * tools, so anything the agent does is immediately visible on screen — that
 * bidirectional link is the point of the demo, not a nicety.
 */

const listeners = new Set();

/**
 * Every store method funnels through api(), so incrementing a counter here
 * gives us a single source of truth for "is anything in flight". Sequential
 * calls (e.g. confirmHandoff → refreshBrief) briefly hit 0 between requests;
 * the render side handles that with a small hide delay to avoid flicker.
 * Parallel calls (refreshAll's brief+assess) stack correctly on a counter.
 */
const api = async (path, options) => {
  store.loading += 1;
  store.emit();
  try {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    });
    return await res.json();
  } finally {
    store.loading -= 1;
    store.emit();
  }
};

export const store = {
  brief: null,
  results: [],
  ledger: [],
  mode: 'unknown',
  pendingHandoff: null,
  toolCalls: [],
  webmcp: { available: false, tools: [] },
  // Count of in-flight fetches. Not a boolean because operations overlap.
  loading: 0,

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { for (const fn of listeners) fn(this); },

  noteToolCall(name, args) {
    this.toolCalls.unshift({ name, args: args ?? {}, at: new Date().toISOString() });
    this.toolCalls = this.toolCalls.slice(0, 12);
    this.emit();
    api('/api/ledger', {
      method: 'POST',
      body: JSON.stringify({ actor: 'agent', kind: 'tool-call', summary: `Agent called ${name}`, detail: args ?? {} }),
    }).then((r) => { if (r?.ledger) { this.ledger = r.ledger; this.emit(); } });
  },

  async refreshBrief() {
    const r = await api('/api/brief');
    this.brief = r.brief;
    this.ledger = r.ledger;
    this.emit();
    return this;
  },

  async refreshAll() {
    const [b, a] = await Promise.all([api('/api/brief'), api('/api/assess')]);
    this.brief = b.brief;
    this.ledger = b.ledger;
    this.results = a.results ?? [];
    this.mode = a.mode ?? 'unknown';
    this.emit();
    return this;
  },

  async assessOne(styleCode) {
    const r = await api(`/api/assess?styleCode=${encodeURIComponent(styleCode)}`);
    if (r?.ok) {
      const i = this.results.findIndex((x) => x.styleCode === styleCode);
      if (i >= 0) this.results[i] = r;
      this.emit();
    }
    return r;
  },

  async applyTradeoff({ type, value, actor = 'user' }) {
    const r = await api('/api/tradeoff', { method: 'POST', body: JSON.stringify({ type, value, actor }) });
    if (r.ok) {
      this.brief = r.brief;
      this.results = r.results;
      this.ledger = r.ledger;
      this.emit();
    }
    return r;
  },

  async prepareHandoff(styleCode, size) {
    const r = await api('/api/handoff/prepare', { method: 'POST', body: JSON.stringify({ styleCode, size }) });
    if (r.ok) {
      this.pendingHandoff = { ...r, requestedAt: Date.now() };
      this.emit();
      this.refreshBrief();
    }
    return r;
  },

  async confirmHandoff(confirmationId, styleCode, size) {
    const id = confirmationId ?? this.pendingHandoff?.confirmationId;
    const sc = styleCode ?? this.pendingHandoff?.item?.styleCode;
    const sz = size ?? this.pendingHandoff?.item?.size;
    const r = await api('/api/handoff/confirm', { method: 'POST', body: JSON.stringify({ confirmationId: id, styleCode: sc, size: sz }) });
    // Clear the modal either way. A stuck card with only Cancel as an escape is
    // worse than a truthful error: the shopper can just click again to retry.
    this.pendingHandoff = null;
    await this.refreshBrief();
    return r;
  },

  clearHandoff() {
    this.pendingHandoff = null;
    this.emit();
  },

  async reset() {
    const r = await api('/api/reset', { method: 'POST' });
    this.brief = r.brief;
    this.results = r.results;
    this.ledger = r.ledger;
    this.toolCalls = [];
    this.pendingHandoff = null;
    this.emit();
    return r;
  },
};

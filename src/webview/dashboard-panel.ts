// @ts-nocheck  — webview context: no vscode types, strict DOM only

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

export {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function kindBadge(kind: string): string {
  return `<span class="badge badge-${kind}">${kind}</span>`;
}

// ── Wire buttons ──────────────────────────────────────────────────────────────

el('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

el('inspector-search').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') triggerSearch();
});
el('btn-inspector-search').addEventListener('click', triggerSearch);

function triggerSearch() {
  const q = (el<HTMLInputElement>('inspector-search')).value.trim();
  if (!q) return;
  vscode.postMessage({ type: 'search', query: q });
}

// ── Message handlers ──────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'stats':          renderStats(msg);         break;
    case 'communities':    renderCommunities(msg);   break;
    case 'tokenUsage':     renderTokenUsage(msg);    break;
    case 'searchResults':  renderSearchResults(msg); break;
    case 'symbolDetail':   renderSymbolDetail(msg);  break;
  }
});

// ── Renderers ─────────────────────────────────────────────────────────────────

function renderStats(msg: any) {
  const countsEl = el('stats-counts');
  countsEl.innerHTML = `
    <div class="stat-chip"><span class="stat-num">${fmt(msg.nodeCount)}</span><span class="stat-lbl">nodes</span></div>
    <div class="stat-chip"><span class="stat-num">${fmt(msg.edgeCount)}</span><span class="stat-lbl">edges total</span></div>
    <div class="stat-chip"><span class="stat-num">${fmt(msg.callEdges)}</span><span class="stat-lbl">calls</span></div>
    <div class="stat-chip"><span class="stat-num">${fmt(msg.implementsEdges)}</span><span class="stat-lbl">implements</span></div>
    <div class="stat-chip"><span class="stat-num">${fmt(msg.injectsEdges)}</span><span class="stat-lbl">injects</span></div>
    <div class="stat-chip"><span class="stat-num">${fmt(msg.tableEdges)}</span><span class="stat-lbl">table refs</span></div>
  `;

  const tbody = el('stats-hotspots').querySelector('tbody')!;
  tbody.innerHTML = (msg.hotspots as any[]).map((h, i) => `
    <tr class="clickable" data-id="${h.id}">
      <td>${i + 1}</td>
      <td><span class="sym-label" title="${h.id}">${h.label}</span></td>
      <td>${kindBadge(h.kind)}</td>
      <td>${h.degree}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr.clickable').forEach(row => {
    row.addEventListener('click', () => {
      const id = (row as HTMLElement).dataset.id!;
      (el<HTMLInputElement>('inspector-search')).value = id;
      vscode.postMessage({ type: 'inspect', nodeId: id });
    });
  });
}

function renderCommunities(msg: any) {
  const list = el('community-list');
  if (!msg.communities.length) {
    list.innerHTML = '<li class="empty">No symbol groupings detected.</li>';
    return;
  }
  list.innerHTML = (msg.communities as any[]).slice(0, 20).map(c => `
    <li class="community-item">
      <div class="community-header">
        <span class="community-name">${c.name}</span>
        <span class="community-size">${c.size} symbols</span>
      </div>
      <div class="community-nodes">
        ${c.topNodes.map((n: any) => `<span class="node-chip clickable" data-id="${n.id}" title="${n.id}">${n.label}</span>`).join('')}
      </div>
    </li>
  `).join('');

  list.querySelectorAll('.node-chip.clickable').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = (chip as HTMLElement).dataset.id!;
      (el<HTMLInputElement>('inspector-search')).value = id;
      vscode.postMessage({ type: 'inspect', nodeId: id });
    });
  });
}

function renderTokenUsage(msg: any) {
  const t = msg.totals;
  el('token-totals').innerHTML = `
    <div class="stat-row">
      <div class="stat-chip"><span class="stat-num">${fmt(t.calls)}</span><span class="stat-lbl">calls</span></div>
      <div class="stat-chip"><span class="stat-num">${fmt(t.promptTokens)}</span><span class="stat-lbl">prompt tokens</span></div>
      <div class="stat-chip"><span class="stat-num">${fmt(t.completionTokens)}</span><span class="stat-lbl">completion tokens</span></div>
      <div class="stat-chip"><span class="stat-num">${fmt(t.promptTokens + t.completionTokens)}</span><span class="stat-lbl">total tokens</span></div>
    </div>
  `;

  const tbody = el('token-table').querySelector('tbody')!;
  if (!msg.records.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No LLM calls yet this session.</td></tr>';
    return;
  }
  tbody.innerHTML = [...msg.records].reverse().slice(0, 50).map((r: any) => `
    <tr>
      <td>${new Date(r.timestamp).toLocaleTimeString()}</td>
      <td>${r.command}</td>
      <td>${r.provider}</td>
      <td class="model-cell" title="${r.model}">${r.model}</td>
      <td class="num">${fmt(r.promptTokens)}</td>
      <td class="num">${fmt(r.completionTokens)}</td>
    </tr>
  `).join('');
}

function renderSearchResults(msg: any) {
  const list = el('inspector-results');
  if (!msg.results.length) {
    list.innerHTML = '<li class="empty">No results.</li>';
    el('inspector-detail').innerHTML = '';
    return;
  }
  list.innerHTML = msg.results.map((r: any) => `
    <li class="result-item clickable" data-id="${r.id}" data-file="${r.file}" data-line="${r.line ?? ''}">
      ${kindBadge(r.kind)}
      <span class="sym-label" title="${r.id}">${r.label}</span>
      <span class="result-file">${r.file ? r.file.split('/').pop() + ':' + r.line : ''}</span>
    </li>
  `).join('');

  list.querySelectorAll('li.result-item').forEach(item => {
    item.addEventListener('click', () => {
      const id   = (item as HTMLElement).dataset.id!;
      const file = (item as HTMLElement).dataset.file;
      const line = (item as HTMLElement).dataset.line;

      list.querySelectorAll('li').forEach(li => li.classList.remove('selected'));
      item.classList.add('selected');

      vscode.postMessage({ type: 'inspect', nodeId: id });

      if (file) {
        vscode.postMessage({ type: 'openFile', file, line: line ? parseInt(line) : undefined });
      }
    });
  });
}

function renderSymbolDetail(msg: any) {
  const div = el('inspector-detail');
  const sections: string[] = [];

  sections.push(`<div class="detail-header">
    <strong>${msg.label}</strong> ${kindBadge(msg.kind ?? 'unknown')}
    ${msg.file ? `<span class="detail-file">${msg.file.split('/').pop()}:${msg.line}</span>` : ''}
  </div>`);

  if (msg.callers?.length) {
    sections.push(`<div class="detail-section">
      <div class="detail-section-title">Callers (${msg.callers.length})</div>
      ${msg.callers.slice(0, 10).map((c: any) => `
        <div class="detail-row clickable" data-id="${c.symbol}" data-file="${c.file}" data-line="${c.line}">
          <span class="sym-label">${c.symbol.split('.').pop()}</span>
          <span class="result-file">${c.file.split('/').pop()}:${c.line}</span>
        </div>`).join('')}
    </div>`);
  }

  if (msg.implementors?.length) {
    sections.push(`<div class="detail-section">
      <div class="detail-section-title">Implementors (${msg.implementors.length})</div>
      ${msg.implementors.slice(0, 10).map((impl: string) => `
        <div class="detail-row clickable" data-id="${impl}">
          <span class="sym-label">${impl.split('.').pop()}</span>
        </div>`).join('')}
    </div>`);
  }

  if (msg.consumers?.length) {
    sections.push(`<div class="detail-section">
      <div class="detail-section-title">Injected into (${msg.consumers.length})</div>
      ${msg.consumers.slice(0, 10).map((c: any) => `
        <div class="detail-row clickable" data-id="${c.symbol}">
          <span class="sym-label">${c.symbol.split('.').pop()}</span>
          <span class="result-file">via ${c.fieldName}</span>
        </div>`).join('')}
    </div>`);
  }

  if (msg.tableRefs?.length) {
    sections.push(`<div class="detail-section">
      <div class="detail-section-title">Table refs (${msg.tableRefs.length})</div>
      ${msg.tableRefs.slice(0, 10).map((t: any) => `
        <div class="detail-row">
          <span class="badge badge-table">${t.operation}</span>
          <span class="sym-label">${t.table}</span>
          <span class="result-file">${t.file.split('/').pop()}:${t.line}</span>
        </div>`).join('')}
    </div>`);
  }

  if (!msg.callers?.length && !msg.implementors?.length && !msg.consumers?.length && !msg.tableRefs?.length) {
    sections.push('<p class="empty">No references found in the indexed workspace.</p>');
  }

  div.innerHTML = sections.join('');

  // Wire navigate-on-click in detail panel
  div.querySelectorAll('.detail-row.clickable').forEach(row => {
    row.addEventListener('click', () => {
      const id   = (row as HTMLElement).dataset.id;
      const file = (row as HTMLElement).dataset.file;
      const line = (row as HTMLElement).dataset.line;
      if (id) vscode.postMessage({ type: 'inspect', nodeId: id });
      if (file) vscode.postMessage({ type: 'openFile', file, line: line ? parseInt(line) : undefined });
    });
  });
}

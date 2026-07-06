"use strict";(()=>{var c=acquireVsCodeApi();function n(s){return document.getElementById(s)}function l(s){return s.toLocaleString()}function p(s){return`<span class="badge badge-${s}">${s}</span>`}n("btn-refresh").addEventListener("click",()=>c.postMessage({type:"refresh"}));n("inspector-search").addEventListener("keydown",s=>{s.key==="Enter"&&r()});n("btn-inspector-search").addEventListener("click",r);function r(){let s=n("inspector-search").value.trim();s&&c.postMessage({type:"search",query:s})}window.addEventListener("message",s=>{let a=s.data;switch(a.type){case"stats":u(a);break;case"communities":m(a);break;case"tokenUsage":v(a);break;case"searchResults":$(a);break;case"symbolDetail":b(a);break}});function u(s){let a=n("stats-counts");a.innerHTML=`
    <div class="stat-chip"><span class="stat-num">${l(s.nodeCount)}</span><span class="stat-lbl">nodes</span></div>
    <div class="stat-chip"><span class="stat-num">${l(s.edgeCount)}</span><span class="stat-lbl">edges total</span></div>
    <div class="stat-chip"><span class="stat-num">${l(s.callEdges)}</span><span class="stat-lbl">calls</span></div>
    <div class="stat-chip"><span class="stat-num">${l(s.implementsEdges)}</span><span class="stat-lbl">implements</span></div>
    <div class="stat-chip"><span class="stat-num">${l(s.injectsEdges)}</span><span class="stat-lbl">injects</span></div>
    <div class="stat-chip"><span class="stat-num">${l(s.tableEdges)}</span><span class="stat-lbl">table refs</span></div>
  `;let t=n("stats-hotspots").querySelector("tbody");t.innerHTML=s.hotspots.map((e,i)=>`
    <tr class="clickable" data-id="${e.id}">
      <td>${i+1}</td>
      <td><span class="sym-label" title="${e.id}">${e.label}</span></td>
      <td>${p(e.kind)}</td>
      <td>${e.degree}</td>
    </tr>
  `).join(""),t.querySelectorAll("tr.clickable").forEach(e=>{e.addEventListener("click",()=>{let i=e.dataset.id;n("inspector-search").value=i,c.postMessage({type:"inspect",nodeId:i})})})}function m(s){let a=n("community-list");if(!s.communities.length){a.innerHTML='<li class="empty">No symbol groupings detected.</li>';return}a.innerHTML=s.communities.slice(0,20).map(t=>`
    <li class="community-item">
      <div class="community-header">
        <span class="community-name">${t.name}</span>
        <span class="community-size">${t.size} symbols</span>
      </div>
      <div class="community-nodes">
        ${t.topNodes.map(e=>`<span class="node-chip clickable" data-id="${e.id}" title="${e.id}">${e.label}</span>`).join("")}
      </div>
    </li>
  `).join(""),a.querySelectorAll(".node-chip.clickable").forEach(t=>{t.addEventListener("click",()=>{let e=t.dataset.id;n("inspector-search").value=e,c.postMessage({type:"inspect",nodeId:e})})})}function v(s){let a=s.totals;n("token-totals").innerHTML=`
    <div class="stat-row">
      <div class="stat-chip"><span class="stat-num">${l(a.calls)}</span><span class="stat-lbl">calls</span></div>
      <div class="stat-chip"><span class="stat-num">${l(a.promptTokens)}</span><span class="stat-lbl">prompt tokens</span></div>
      <div class="stat-chip"><span class="stat-num">${l(a.completionTokens)}</span><span class="stat-lbl">completion tokens</span></div>
      <div class="stat-chip"><span class="stat-num">${l(a.promptTokens+a.completionTokens)}</span><span class="stat-lbl">total tokens</span></div>
    </div>
  `;let t=n("token-table").querySelector("tbody");if(!s.records.length){t.innerHTML='<tr><td colspan="6" class="empty">No LLM calls yet this session.</td></tr>';return}t.innerHTML=[...s.records].reverse().slice(0,50).map(e=>`
    <tr>
      <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
      <td>${e.command}</td>
      <td>${e.provider}</td>
      <td class="model-cell" title="${e.model}">${e.model}</td>
      <td class="num">${l(e.promptTokens)}</td>
      <td class="num">${l(e.completionTokens)}</td>
    </tr>
  `).join("")}function $(s){let a=n("inspector-results");if(!s.results.length){a.innerHTML='<li class="empty">No results.</li>',n("inspector-detail").innerHTML="";return}a.innerHTML=s.results.map(t=>`
    <li class="result-item clickable" data-id="${t.id}" data-file="${t.file}" data-line="${t.line??""}">
      ${p(t.kind)}
      <span class="sym-label" title="${t.id}">${t.label}</span>
      <span class="result-file">${t.file?t.file.split("/").pop()+":"+t.line:""}</span>
    </li>
  `).join(""),a.querySelectorAll("li.result-item").forEach(t=>{t.addEventListener("click",()=>{let e=t.dataset.id,i=t.dataset.file,d=t.dataset.line;a.querySelectorAll("li").forEach(o=>o.classList.remove("selected")),t.classList.add("selected"),c.postMessage({type:"inspect",nodeId:e}),i&&c.postMessage({type:"openFile",file:i,line:d?parseInt(d):void 0})})})}function b(s){let a=n("inspector-detail"),t=[];t.push(`<div class="detail-header">
    <strong>${s.label}</strong> ${p(s.kind??"unknown")}
    ${s.file?`<span class="detail-file">${s.file.split("/").pop()}:${s.line}</span>`:""}
  </div>`),s.callers?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Callers (${s.callers.length})</div>
      ${s.callers.slice(0,10).map(e=>`
        <div class="detail-row clickable" data-id="${e.symbol}" data-file="${e.file}" data-line="${e.line}">
          <span class="sym-label">${e.symbol.split(".").pop()}</span>
          <span class="result-file">${e.file.split("/").pop()}:${e.line}</span>
        </div>`).join("")}
    </div>`),s.implementors?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Implementors (${s.implementors.length})</div>
      ${s.implementors.slice(0,10).map(e=>`
        <div class="detail-row clickable" data-id="${e}">
          <span class="sym-label">${e.split(".").pop()}</span>
        </div>`).join("")}
    </div>`),s.consumers?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Injected into (${s.consumers.length})</div>
      ${s.consumers.slice(0,10).map(e=>`
        <div class="detail-row clickable" data-id="${e.symbol}">
          <span class="sym-label">${e.symbol.split(".").pop()}</span>
          <span class="result-file">via ${e.fieldName}</span>
        </div>`).join("")}
    </div>`),s.tableRefs?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Table refs (${s.tableRefs.length})</div>
      ${s.tableRefs.slice(0,10).map(e=>`
        <div class="detail-row">
          <span class="badge badge-table">${e.operation}</span>
          <span class="sym-label">${e.table}</span>
          <span class="result-file">${e.file.split("/").pop()}:${e.line}</span>
        </div>`).join("")}
    </div>`),!s.callers?.length&&!s.implementors?.length&&!s.consumers?.length&&!s.tableRefs?.length&&t.push('<p class="empty">No references found in the indexed workspace.</p>'),a.innerHTML=t.join(""),a.querySelectorAll(".detail-row.clickable").forEach(e=>{e.addEventListener("click",()=>{let i=e.dataset.id,d=e.dataset.file,o=e.dataset.line;i&&c.postMessage({type:"inspect",nodeId:i}),d&&c.postMessage({type:"openFile",file:d,line:o?parseInt(o):void 0})})})}})();

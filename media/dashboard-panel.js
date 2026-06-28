"use strict";(()=>{var c=acquireVsCodeApi();function a(e){return document.getElementById(e)}function i(e){return e.toLocaleString()}function u(e){let n=Date.now()-e,t=Math.floor(n/1e3);return t<60?`${t}s ago`:t<3600?`${Math.floor(t/60)}m ago`:`${Math.floor(t/3600)}h ago`}function r(e){return`<span class="badge badge-${e}">${e}</span>`}a("btn-refresh").addEventListener("click",()=>c.postMessage({type:"refresh"}));a("btn-run-graphify").addEventListener("click",()=>{a("btn-run-graphify").setAttribute("disabled","true"),a("run-status").textContent="Running graphify\u2026",c.postMessage({type:"runGraphify"})});a("inspector-search").addEventListener("keydown",e=>{e.key==="Enter"&&p()});a("btn-inspector-search").addEventListener("click",p);function p(){let e=a("inspector-search").value.trim();e&&c.postMessage({type:"search",query:e})}window.addEventListener("message",e=>{let n=e.data;switch(n.type){case"stats":m(n);break;case"communities":b(n);break;case"runInfo":f(n);break;case"tokenUsage":v(n);break;case"searchResults":y(n);break;case"symbolDetail":$(n);break;case"graphifyRunning":{a("btn-run-graphify").setAttribute("disabled","true"),a("run-status").textContent="Running graphify\u2026";break}case"graphifyDone":{a("btn-run-graphify").removeAttribute("disabled"),a("run-status").textContent="";break}}});function m(e){let n=a("stats-counts");n.innerHTML=`
    <div class="stat-chip"><span class="stat-num">${i(e.nodeCount)}</span><span class="stat-lbl">nodes</span></div>
    <div class="stat-chip"><span class="stat-num">${i(e.edgeCount)}</span><span class="stat-lbl">edges total</span></div>
    <div class="stat-chip"><span class="stat-num">${i(e.callEdges)}</span><span class="stat-lbl">calls</span></div>
    <div class="stat-chip"><span class="stat-num">${i(e.implementsEdges)}</span><span class="stat-lbl">implements</span></div>
    <div class="stat-chip"><span class="stat-num">${i(e.injectsEdges)}</span><span class="stat-lbl">injects</span></div>
    <div class="stat-chip"><span class="stat-num">${i(e.tableEdges)}</span><span class="stat-lbl">table refs</span></div>
  `;let t=a("stats-hotspots").querySelector("tbody");t.innerHTML=e.hotspots.map((s,l)=>`
    <tr class="clickable" data-id="${s.id}">
      <td>${l+1}</td>
      <td><span class="sym-label" title="${s.id}">${s.label}</span></td>
      <td>${r(s.kind)}</td>
      <td>${s.degree}</td>
    </tr>
  `).join(""),t.querySelectorAll("tr.clickable").forEach(s=>{s.addEventListener("click",()=>{let l=s.dataset.id;a("inspector-search").value=l,c.postMessage({type:"inspect",nodeId:l})})})}function b(e){let n=a("community-list");if(!e.communities.length){n.innerHTML='<li class="empty">No symbol groupings detected.</li>';return}n.innerHTML=e.communities.slice(0,20).map(t=>`
    <li class="community-item">
      <div class="community-header">
        <span class="community-name">${t.name}</span>
        <span class="community-size">${t.size} symbols</span>
      </div>
      <div class="community-nodes">
        ${t.topNodes.map(s=>`<span class="node-chip clickable" data-id="${s.id}" title="${s.id}">${s.label}</span>`).join("")}
      </div>
    </li>
  `).join(""),n.querySelectorAll(".node-chip.clickable").forEach(t=>{t.addEventListener("click",()=>{let s=t.dataset.id;a("inspector-search").value=s,c.postMessage({type:"inspect",nodeId:s})})})}function f(e){let n=a("run-info"),t=e.infos;if(!t.length){n.innerHTML='<p class="empty">No workspace folders.</p>';return}n.innerHTML=t.map(s=>{if(!s.exists)return`<div class="run-row"><span class="run-path">${s.root}</span><span class="badge badge-warn">no graph.json</span></div>`;let l=s.mtimeMs?u(s.mtimeMs):"\u2014",o=s.sizeBytes?`${(s.sizeBytes/1024).toFixed(1)} KB`:"\u2014";return`
      <div class="run-row">
        <span class="run-path" title="${s.root}">${s.root.split("/").pop()}</span>
        <span class="run-meta">Last run: <strong>${l}</strong> \xB7 ${o}</span>
      </div>`}).join(""),a("btn-run-graphify").removeAttribute("disabled"),a("run-status").textContent=""}function v(e){let n=e.totals;a("token-totals").innerHTML=`
    <div class="stat-row">
      <div class="stat-chip"><span class="stat-num">${i(n.calls)}</span><span class="stat-lbl">calls</span></div>
      <div class="stat-chip"><span class="stat-num">${i(n.promptTokens)}</span><span class="stat-lbl">prompt tokens</span></div>
      <div class="stat-chip"><span class="stat-num">${i(n.completionTokens)}</span><span class="stat-lbl">completion tokens</span></div>
      <div class="stat-chip"><span class="stat-num">${i(n.promptTokens+n.completionTokens)}</span><span class="stat-lbl">total tokens</span></div>
    </div>
  `;let t=a("token-table").querySelector("tbody");if(!e.records.length){t.innerHTML='<tr><td colspan="6" class="empty">No LLM calls yet this session.</td></tr>';return}t.innerHTML=[...e.records].reverse().slice(0,50).map(s=>`
    <tr>
      <td>${new Date(s.timestamp).toLocaleTimeString()}</td>
      <td>${s.command}</td>
      <td>${s.provider}</td>
      <td class="model-cell" title="${s.model}">${s.model}</td>
      <td class="num">${i(s.promptTokens)}</td>
      <td class="num">${i(s.completionTokens)}</td>
    </tr>
  `).join("")}function y(e){let n=a("inspector-results");if(!e.results.length){n.innerHTML='<li class="empty">No results.</li>',a("inspector-detail").innerHTML="";return}n.innerHTML=e.results.map(t=>`
    <li class="result-item clickable" data-id="${t.id}" data-file="${t.file}" data-line="${t.line??""}">
      ${r(t.kind)}
      <span class="sym-label" title="${t.id}">${t.label}</span>
      <span class="result-file">${t.file?t.file.split("/").pop()+":"+t.line:""}</span>
    </li>
  `).join(""),n.querySelectorAll("li.result-item").forEach(t=>{t.addEventListener("click",()=>{let s=t.dataset.id,l=t.dataset.file,o=t.dataset.line;n.querySelectorAll("li").forEach(d=>d.classList.remove("selected")),t.classList.add("selected"),c.postMessage({type:"inspect",nodeId:s}),l&&c.postMessage({type:"openFile",file:l,line:o?parseInt(o):void 0})})})}function $(e){let n=a("inspector-detail"),t=[];t.push(`<div class="detail-header">
    <strong>${e.label}</strong> ${r(e.kind??"unknown")}
    ${e.file?`<span class="detail-file">${e.file.split("/").pop()}:${e.line}</span>`:""}
  </div>`),e.callers?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Callers (${e.callers.length})</div>
      ${e.callers.slice(0,10).map(s=>`
        <div class="detail-row clickable" data-id="${s.symbol}" data-file="${s.file}" data-line="${s.line}">
          <span class="sym-label">${s.symbol.split(".").pop()}</span>
          <span class="result-file">${s.file.split("/").pop()}:${s.line}</span>
        </div>`).join("")}
    </div>`),e.implementors?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Implementors (${e.implementors.length})</div>
      ${e.implementors.slice(0,10).map(s=>`
        <div class="detail-row clickable" data-id="${s}">
          <span class="sym-label">${s.split(".").pop()}</span>
        </div>`).join("")}
    </div>`),e.consumers?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Injected into (${e.consumers.length})</div>
      ${e.consumers.slice(0,10).map(s=>`
        <div class="detail-row clickable" data-id="${s.symbol}">
          <span class="sym-label">${s.symbol.split(".").pop()}</span>
          <span class="result-file">via ${s.fieldName}</span>
        </div>`).join("")}
    </div>`),e.tableRefs?.length&&t.push(`<div class="detail-section">
      <div class="detail-section-title">Table refs (${e.tableRefs.length})</div>
      ${e.tableRefs.slice(0,10).map(s=>`
        <div class="detail-row">
          <span class="badge badge-table">${s.operation}</span>
          <span class="sym-label">${s.table}</span>
          <span class="result-file">${s.file.split("/").pop()}:${s.line}</span>
        </div>`).join("")}
    </div>`),!e.callers?.length&&!e.implementors?.length&&!e.consumers?.length&&!e.tableRefs?.length&&t.push('<p class="empty">No references found in the indexed workspace.</p>'),n.innerHTML=t.join(""),n.querySelectorAll(".detail-row.clickable").forEach(s=>{s.addEventListener("click",()=>{let l=s.dataset.id,o=s.dataset.file,d=s.dataset.line;l&&c.postMessage({type:"inspect",nodeId:l}),o&&c.postMessage({type:"openFile",file:o,line:d?parseInt(d):void 0})})})}})();

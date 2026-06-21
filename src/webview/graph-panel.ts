import * as THREE from 'three';

// ── VS Code webview API ───────────────────────────────────────────────────────
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// ── Message types ─────────────────────────────────────────────────────────────
interface GraphNode {
  id: string;
  label: string;
  kind: string;
  file?: string;
  line?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

interface SimNode extends GraphNode {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

type InboundMsg =
  | { type: 'stats';         nodeCount: number; edgeCount: number }
  | { type: 'searchResults'; results: GraphNode[] }
  | { type: 'subgraph';      centerId: string; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'reloading' };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const graphDiv    = document.getElementById('graph')!;
const searchEl    = document.getElementById('search')    as HTMLInputElement;
const resultsEl   = document.getElementById('results')!;
const detailEl    = document.getElementById('detail')!;
const statsEl     = document.getElementById('stats')!;
const btnOverview = document.getElementById('btn-overview') as HTMLButtonElement;
const btnClear    = document.getElementById('btn-clear')    as HTMLButtonElement;
const btnReload   = document.getElementById('btn-reload')   as HTMLButtonElement;

// ── Palette ───────────────────────────────────────────────────────────────────
const KIND_HEX: Record<string, number> = {
  class:       0x4FC3F7,
  interface:   0xCE93D8,
  method:      0x81C784,
  constructor: 0xFFB74D,
  table:       0xFF8A65,
  field:       0x90A4AE,
  unknown:     0x78909C,
};

const EDGE_HEX: Record<string, number> = {
  calls:      0x90A4AE,
  implements: 0xCE93D8,
  injects:    0x4FC3F7,
  SELECT:     0x66BB6A,
  INSERT:     0xEF5350,
  UPDATE:     0xFFA726,
  DELETE:     0xEF5350,
  MERGE:      0xAB47BC,
  unknown:    0x78909C,
};

const KIND_CSS: Record<string, string> = {
  class: '#4FC3F7', interface: '#CE93D8', method: '#81C784',
  constructor: '#FFB74D', table: '#FF8A65', field: '#90A4AE', unknown: '#78909C',
};

// ── Scene setup ───────────────────────────────────────────────────────────────
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(55, 1, 0.5, 15000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = false;
graphDiv.appendChild(renderer.domElement);

// Theme-aware background — read VS Code CSS custom property
const rawBg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
try { renderer.setClearColor(new THREE.Color(rawBg), 1); }
catch { renderer.setClearColor(0x1e1e1e, 1); }

// Lights
const ambient = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambient);
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(200, 400, 300);
scene.add(key);
const fill = new THREE.PointLight(0x8080ff, 0.4, 2000);
fill.position.set(-300, -200, -300);
scene.add(fill);

// ── Graph state ───────────────────────────────────────────────────────────────
let simNodes:  SimNode[]  = [];
let edges:     GraphEdge[] = [];
let nodeMap    = new Map<string, SimNode>();
let centerId   = '';
let selected:  SimNode | null = null;

// Three.js object tracking for disposal
interface NodeObjects {
  mesh:  THREE.Mesh;
  label: THREE.Sprite;
  ring?:  THREE.LineLoop;
  data:  SimNode;
}
interface EdgeObjects {
  line: THREE.Line;
  cone: THREE.Mesh;
}

let nodeMeshes = new Map<string, NodeObjects>();
let edgeMeshes: EdgeObjects[] = [];
let pickTargets: THREE.Mesh[] = [];   // raycasting candidates

// ── Simulation parameters ─────────────────────────────────────────────────────
const SIM = {
  REPEL:    12000,
  SPRING:   0.022,
  REST_LEN: 160,
  DAMPING:  0.76,
  GRAVITY:  0.006,
};

let simActive = false;
let stableFor = 0;

// ── Camera orbit ──────────────────────────────────────────────────────────────
const sph = { theta: 0.4, phi: 1.1, radius: 700 };
const target = new THREE.Vector3();
let isOrbiting = false;
let isPanning  = false;
let lastMouse  = { x: 0, y: 0 };
let movedDuring = false;

function syncCamera(): void {
  const { theta, phi, radius } = sph;
  camera.position.set(
    target.x + radius * Math.sin(phi) * Math.sin(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.cos(theta),
  );
  camera.lookAt(target);
}
syncCamera();

// ── Three.js geometry helpers ─────────────────────────────────────────────────
const SPHERE_GEO_LG = new THREE.SphereGeometry(22, 32, 16);  // center node
const SPHERE_GEO_SM = new THREE.SphereGeometry(15, 28, 14);  // other nodes
const CONE_GEO      = new THREE.ConeGeometry(3.5, 12, 8);

function makeNodeMat(color: number, isCenter: boolean): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color,
    emissive:          new THREE.Color(color),
    emissiveIntensity: isCenter ? 0.45 : 0.18,
    shininess:         90,
    specular:          new THREE.Color(0xffffff),
  });
}

function makeLabelSprite(text: string, isCenter: boolean): THREE.Sprite {
  const W = 256, H = 56;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d')!;

  // Background pill
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(4, 8, W - 8, H - 16, 8);
  ctx.fill();

  const lbl  = text.length > 15 ? text.slice(0, 14) + '…' : text;
  const size = isCenter ? 20 : 16;
  ctx.fillStyle = isCenter ? '#ffffff' : '#e0e0e0';
  ctx.font      = `${isCenter ? 'bold ' : ''}${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(lbl, W / 2, H / 2);

  const tex = new THREE.CanvasTexture(cvs);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, opacity: 0.92 });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(isCenter ? 92 : 76, isCenter ? 22 : 18, 1);
  return spr;
}

function makeSelectionRing(radius: number, color: number): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * (radius + 5), Math.sin(a) * (radius + 5), 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
  return new THREE.LineLoop(geo, mat);
}

// ── Scene population ──────────────────────────────────────────────────────────
function clearScene(): void {
  for (const { mesh, label, ring } of nodeMeshes.values()) {
    scene.remove(mesh);   mesh.geometry.dispose();  (mesh.material as THREE.Material).dispose();
    scene.remove(label);  label.material.map?.dispose();  label.material.dispose();
    if (ring) { scene.remove(ring); ring.geometry.dispose(); (ring.material as THREE.Material).dispose(); }
  }
  for (const { line, cone } of edgeMeshes) {
    scene.remove(line); line.geometry.dispose(); (line.material as THREE.Material).dispose();
    scene.remove(cone); cone.geometry.dispose(); (cone.material as THREE.Material).dispose();
  }
  nodeMeshes.clear();
  edgeMeshes = [];
  pickTargets = [];
}

function buildNodeMesh(n: SimNode): void {
  const isCenter = n.id === centerId;
  const color    = KIND_HEX[n.kind] ?? KIND_HEX.unknown;

  const mesh  = new THREE.Mesh(isCenter ? SPHERE_GEO_LG : SPHERE_GEO_SM, makeNodeMat(color, isCenter));
  mesh.position.set(n.x, n.y, n.z);
  mesh.userData = n;
  scene.add(mesh);

  const label = makeLabelSprite(n.label, isCenter);
  label.position.set(n.x, n.y + (isCenter ? 32 : 24), n.z);
  scene.add(label);

  nodeMeshes.set(n.id, { mesh, label, data: n });
  pickTargets.push(mesh);
}

const UP = new THREE.Vector3(0, 1, 0);

function buildEdgeMesh(e: GraphEdge): void {
  const a = nodeMap.get(e.source);
  const b = nodeMap.get(e.target);
  if (!a || !b) return;

  const color = EDGE_HEX[e.label] ?? EDGE_HEX.unknown;

  // Line
  const pts = [new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z)];
  const lineMat = new THREE.LineBasicMaterial({ color, opacity: 0.45, transparent: true });
  const line    = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
  scene.add(line);

  // Arrowhead cone
  const dir  = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const len  = dir.length();
  dir.normalize();

  const cone    = new THREE.Mesh(CONE_GEO, new THREE.MeshBasicMaterial({ color, opacity: 0.65, transparent: true }));
  const conePos = new THREE.Vector3(a.x, a.y, a.z).addScaledVector(dir, len * 0.72);
  cone.position.copy(conePos);

  if (dir.dot(UP) > -0.9999) {
    cone.quaternion.setFromUnitVectors(UP, dir);
  } else {
    cone.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  }
  scene.add(cone);

  edgeMeshes.push({ line, cone });
}

// ── Simulation step ───────────────────────────────────────────────────────────
function simulateStep(): void {
  const { REPEL, SPRING, REST_LEN, DAMPING, GRAVITY } = SIM;

  for (let i = 0; i < simNodes.length; i++) {
    for (let j = i + 1; j < simNodes.length; j++) {
      const a = simNodes[i], b = simNodes[j];
      const dx = (b.x - a.x) || 0.01;
      const dy = (b.y - a.y) || 0.01;
      const dz = (b.z - a.z) || 0.01;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d  = Math.sqrt(d2);
      const f  = REPEL / d2;
      const fx = f * dx / d, fy = f * dy / d, fz = f * dz / d;
      a.vx -= fx; a.vy -= fy; a.vz -= fz;
      b.vx += fx; b.vy += fy; b.vz += fz;
    }
  }

  for (const e of edges) {
    const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d  = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const f  = SPRING * (d - REST_LEN);
    const fx = f * dx / d, fy = f * dy / d, fz = f * dz / d;
    a.vx += fx; a.vy += fy; a.vz += fz;
    b.vx -= fx; b.vy -= fy; b.vz -= fz;
  }

  for (const n of simNodes) {
    n.vx -= n.x * GRAVITY; n.vy -= n.y * GRAVITY; n.vz -= n.z * GRAVITY;
    n.vx *= DAMPING; n.vy *= DAMPING; n.vz *= DAMPING;
    n.x  += n.vx;    n.y  += n.vy;    n.z  += n.vz;
  }
}

function syncMeshPositions(): void {
  for (const { mesh, label, data: n } of nodeMeshes.values()) {
    const isCenter = n.id === centerId;
    mesh.position.set(n.x, n.y, n.z);
    label.position.set(n.x, n.y + (isCenter ? 32 : 24), n.z);
  }

  for (let i = 0; i < edgeMeshes.length; i++) {
    const { line, cone } = edgeMeshes[i];
    const e = edges[i];
    if (!e) continue;
    const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
    if (!a || !b) continue;

    const pos = line.geometry.attributes['position'] as THREE.BufferAttribute;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;

    const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = dir.length();
    dir.normalize();
    cone.position.copy(new THREE.Vector3(a.x, a.y, a.z).addScaledVector(dir, len * 0.72));
    if (dir.dot(UP) > -0.9999) {
      cone.quaternion.setFromUnitVectors(UP, dir);
    } else {
      cone.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    }
  }
}

// ── Subgraph loading ──────────────────────────────────────────────────────────
function loadSubgraph(msg: Extract<InboundMsg, { type: 'subgraph' }>): void {
  centerId = msg.centerId;
  clearScene();

  const scatter = centerId === '' ? 900 : 380;
  simNodes = msg.nodes.map(n => ({
    ...n,
    x:  n.id === centerId ? 0 : (Math.random() - 0.5) * scatter,
    y:  n.id === centerId ? 0 : (Math.random() - 0.5) * scatter,
    z:  n.id === centerId ? 0 : (Math.random() - 0.5) * scatter,
    vx: 0, vy: 0, vz: 0,
  }));
  edges   = msg.edges;
  nodeMap = new Map(simNodes.map(n => [n.id, n]));
  selected = null;

  for (const n of simNodes) buildNodeMesh(n);
  for (const e of edges)   buildEdgeMesh(e);

  // Reset camera — zoom out more for overview (many nodes)
  target.set(0, 0, 0);
  sph.theta = 0.4; sph.phi = 1.1;
  sph.radius = centerId === '' ? 1800 : 700;
  syncCamera();

  simActive = true;
  stableFor = 0;
  showDetail(null);
}

// ── Selection ─────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

function handlePick(e: MouseEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x  = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y  = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(pickTargets);
  if (hits.length > 0) {
    const node = hits[0].object.userData as SimNode;
    setSelected(node);
    if (!node.id.startsWith('table:')) {
      vscode.postMessage({ type: 'expand', nodeId: node.id });
    }
  } else {
    setSelected(null);
  }
}

function setSelected(node: SimNode | null): void {
  // Remove old ring
  const prev = selected ? nodeMeshes.get(selected.id) : null;
  if (prev?.ring) { scene.remove(prev.ring); prev.ring.geometry.dispose(); (prev.ring.material as THREE.Material).dispose(); prev.ring = undefined; }

  selected = node;
  showDetail(node);

  if (!node) {
    // Reset all emissive intensities
    for (const [id, { mesh }] of nodeMeshes) {
      (mesh.material as THREE.MeshPhongMaterial).emissiveIntensity = id === centerId ? 0.45 : 0.18;
    }
    return;
  }

  // Highlight selected
  const obj = nodeMeshes.get(node.id);
  if (!obj) return;
  (obj.mesh.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.9;

  // Add selection ring
  const r     = node.id === centerId ? 22 : 15;
  const color = KIND_HEX[node.kind] ?? KIND_HEX.unknown;
  const ring  = makeSelectionRing(r, color);
  ring.position.copy(obj.mesh.position);
  ring.lookAt(camera.position);
  scene.add(ring);
  obj.ring = ring;

  // Dim others
  for (const [id, { mesh }] of nodeMeshes) {
    if (id !== node.id) {
      (mesh.material as THREE.MeshPhongMaterial).emissiveIntensity = id === centerId ? 0.3 : 0.08;
    }
  }
}

// ── Camera controls ───────────────────────────────────────────────────────────
const domEl = renderer.domElement;

domEl.addEventListener('mousedown', e => {
  movedDuring = false;
  lastMouse   = { x: e.clientX, y: e.clientY };
  if (e.button === 0) isOrbiting = true;
  if (e.button === 2) isPanning  = true;
});

domEl.addEventListener('mousemove', e => {
  if (!isOrbiting && !isPanning) return;
  const dx = e.clientX - lastMouse.x;
  const dy = e.clientY - lastMouse.y;
  lastMouse = { x: e.clientX, y: e.clientY };
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) movedDuring = true;

  if (isOrbiting) {
    sph.theta -= dx * 0.006;
    sph.phi    = Math.max(0.08, Math.min(Math.PI - 0.08, sph.phi + dy * 0.006));
  }

  if (isPanning) {
    // Camera-relative pan — project onto right/up vectors
    const right = new THREE.Vector3();
    const up    = new THREE.Vector3();
    const fwd   = new THREE.Vector3();
    camera.matrixWorld.extractBasis(right, up, fwd);
    const speed = sph.radius * 0.001;
    target.addScaledVector(right, -dx * speed);
    target.addScaledVector(up,     dy * speed);
  }

  syncCamera();
});

domEl.addEventListener('mouseup', e => {
  if (!movedDuring && e.button === 0) handlePick(e);
  isOrbiting = false;
  isPanning  = false;
});

domEl.addEventListener('contextmenu', e => e.preventDefault());

domEl.addEventListener('wheel', e => {
  e.preventDefault();
  sph.radius = Math.max(80, Math.min(5000, sph.radius * (e.deltaY > 0 ? 1.1 : 0.91)));
  syncCamera();
}, { passive: false });

// ── Animation loop ────────────────────────────────────────────────────────────
function animate(): void {
  requestAnimationFrame(animate);

  if (simActive) {
    simulateStep();
    syncMeshPositions();

    // Keep selection ring billboard-aligned during simulation
    if (selected) {
      const obj = nodeMeshes.get(selected.id);
      if (obj?.ring) { obj.ring.position.copy(obj.mesh.position); obj.ring.lookAt(camera.position); }
    }

    const energy = simNodes.reduce((s, n) => s + n.vx * n.vx + n.vy * n.vy + n.vz * n.vz, 0);
    if (energy < 0.06) { stableFor++; if (stableFor > 50) simActive = false; }
    else stableFor = 0;
  } else {
    // Keep selection ring facing camera while idle too
    if (selected) {
      const obj = nodeMeshes.get(selected.id);
      if (obj?.ring) obj.ring.lookAt(camera.position);
    }
  }

  renderer.render(scene, camera);
}

// ── Resize ────────────────────────────────────────────────────────────────────
function resize(): void {
  const w = graphDiv.clientWidth;
  const h = graphDiv.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

new ResizeObserver(resize).observe(graphDiv);
resize();

// ── Search UI ─────────────────────────────────────────────────────────────────
let debounce: ReturnType<typeof setTimeout> | null = null;

searchEl.addEventListener('input', () => {
  if (debounce) clearTimeout(debounce);
  const q = searchEl.value.trim();
  if (q.length < 2) { hideResults(); return; }
  debounce = setTimeout(() => vscode.postMessage({ type: 'search', query: q }), 180);
});

searchEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideResults(); searchEl.blur(); }
});

document.addEventListener('click', e => {
  if (!resultsEl.contains(e.target as Node) && e.target !== searchEl) hideResults();
});

function hideResults(): void {
  resultsEl.style.display = 'none';
  resultsEl.innerHTML = '';
}

function renderResults(list: GraphNode[]): void {
  if (!list.length) {
    resultsEl.innerHTML = '<div class="no-results">No matches</div>';
    resultsEl.style.display = 'block';
    return;
  }
  resultsEl.innerHTML = list.map(r => {
    const color = KIND_CSS[r.kind] ?? KIND_CSS.unknown;
    return `<div class="result-item" data-id="${esc(r.id)}">
      <span class="kind-dot" style="background:${color}"></span>
      <span class="result-label">${esc(r.label)}</span>
      <span class="result-kind">${esc(r.kind)}</span>
    </div>`;
  }).join('');
  resultsEl.style.display = 'block';

  resultsEl.querySelectorAll<HTMLElement>('.result-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset['id']!;
      searchEl.value = id;
      hideResults();
      vscode.postMessage({ type: 'expand', nodeId: id });
    });
  });
}

// ── Detail bar ────────────────────────────────────────────────────────────────
function showDetail(node: SimNode | null): void {
  if (!node) {
    detailEl.innerHTML = '<p class="hint">Left-drag to orbit · Right-drag to pan · Scroll to zoom · Click a node to expand</p>';
    return;
  }
  const color = KIND_CSS[node.kind] ?? KIND_CSS.unknown;
  const filePart = node.file
    ? `<div class="detail-sub">${esc(node.file.split('/').slice(-2).join('/'))}${node.line ? ':' + node.line : ''}</div>`
    : '';
  detailEl.innerHTML = `
    <div class="detail-header">
      <span class="kind-badge" style="background:${color}">${esc(node.kind)}</span>
      <strong>${esc(node.label)}</strong>
    </div>
    ${filePart}
    <div class="detail-sub" style="color:var(--vscode-textLink-foreground)">${esc(node.id)}</div>`;
}

// ── Toolbar buttons ───────────────────────────────────────────────────────────
btnOverview.addEventListener('click', () => {
  vscode.postMessage({ type: 'overview' });
});

btnClear.addEventListener('click', () => {
  clearScene();
  simNodes = []; edges = []; nodeMap = new Map(); selected = null; centerId = '';
  simActive = false;
  showDetail(null);
});

btnReload.addEventListener('click', () => {
  btnReload.disabled = true;
  btnReload.classList.add('spinning');
  btnReload.textContent = '↺ Indexing…';
  vscode.postMessage({ type: 'reload' });
});

// ── Extension messages ────────────────────────────────────────────────────────
window.addEventListener('message', ({ data }: MessageEvent<InboundMsg>) => {
  switch (data.type) {
    case 'stats':
      statsEl.textContent = `${data.nodeCount} nodes · ${data.edgeCount} edges`;
      break;
    case 'searchResults':
      renderResults(data.results);
      break;
    case 'subgraph':
      loadSubgraph(data);
      // Restore reload button after overview arrives
      btnReload.disabled = false;
      btnReload.classList.remove('spinning');
      btnReload.textContent = '↺ Re-index';
      break;
    case 'reloading':
      statsEl.textContent = 'Indexing…';
      break;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Start render loop
animate();

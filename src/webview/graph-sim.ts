// Pure force-directed simulation logic for the graph webview.
// No THREE or DOM dependencies — unit-testable outside the browser.

export interface SimNodeState {
  id: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

export interface SimEdge {
  source: string;
  target: string;
}

export interface SimParams {
  REPEL: number;
  SPRING: number;
  REST_LEN: number;
  DAMPING: number;
  GRAVITY: number;
}

export const SIM: SimParams = {
  REPEL:    12000,
  SPRING:   0.022,
  REST_LEN: 160,
  DAMPING:  0.76,
  GRAVITY:  0.006,
};

// One integration step: pairwise repulsion, spring attraction along edges,
// centering gravity, then damped velocity integration. Mutates nodes in place.
export function simulateStep(
  nodes: SimNodeState[],
  edges: SimEdge[],
  nodeMap: Map<string, SimNodeState>,
  params: SimParams = SIM,
): void {
  const { REPEL, SPRING, REST_LEN, DAMPING, GRAVITY } = params;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
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

  for (const n of nodes) {
    n.vx -= n.x * GRAVITY; n.vy -= n.y * GRAVITY; n.vz -= n.z * GRAVITY;
    n.vx *= DAMPING; n.vy *= DAMPING; n.vz *= DAMPING;
    n.x  += n.vx;    n.y  += n.vy;    n.z  += n.vz;
  }
}

// Kinetic energy proxy used to detect a settled layout.
export function totalEnergy(nodes: SimNodeState[]): number {
  return nodes.reduce((s, n) => s + n.vx * n.vx + n.vy * n.vy + n.vz * n.vz, 0);
}

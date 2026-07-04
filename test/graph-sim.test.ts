import { describe, expect, it } from 'vitest';
import { SIM, simulateStep, totalEnergy, type SimNodeState } from '../src/webview/graph-sim';

function node(id: string, x = 0, y = 0, z = 0): SimNodeState {
  return { id, x, y, z, vx: 0, vy: 0, vz: 0 };
}

function mapOf(nodes: SimNodeState[]): Map<string, SimNodeState> {
  return new Map(nodes.map(n => [n.id, n]));
}

describe('simulateStep', () => {
  it('pushes unconnected nodes apart', () => {
    const a = node('a', -10);
    const b = node('b', 10);
    const nodes = [a, b];

    simulateStep(nodes, [], mapOf(nodes));

    expect(a.x).toBeLessThan(-10);
    expect(b.x).toBeGreaterThan(10);
  });

  it('pulls connected nodes together beyond rest length', () => {
    const a = node('a', -200);
    const b = node('b', 200); // distance 400 > REST_LEN
    const nodes = [a, b];

    simulateStep(nodes, [{ source: 'a', target: 'b' }], mapOf(nodes));

    expect(a.x).toBeGreaterThan(-200);
    expect(b.x).toBeLessThan(200);
  });

  it('applies centering gravity to an isolated node', () => {
    const a = node('a', 100, 50, -80);

    simulateStep([a], [], mapOf([a]));

    expect(Math.abs(a.x)).toBeLessThan(100);
    expect(Math.abs(a.y)).toBeLessThan(50);
    expect(Math.abs(a.z)).toBeLessThan(80);
  });

  it('ignores edges whose endpoints are missing from the node map', () => {
    const a = node('a', 100);

    simulateStep([a], [{ source: 'a', target: 'ghost' }], mapOf([a]));

    expect(Number.isFinite(a.x)).toBe(true);
  });

  it('settles below the stability threshold with damping', () => {
    const a = node('a', -300, 40, 10);
    const b = node('b', 300, -40, -10);
    const nodes = [a, b];
    const edges = [{ source: 'a', target: 'b' }];
    const byId = mapOf(nodes);

    for (let i = 0; i < 500; i++) simulateStep(nodes, edges, byId);

    expect(totalEnergy(nodes)).toBeLessThan(0.06);
  });
});

describe('totalEnergy', () => {
  it('is zero for nodes at rest', () => {
    expect(totalEnergy([node('a', 5, 5, 5), node('b')])).toBe(0);
  });

  it('sums squared velocity components', () => {
    const a = node('a');
    a.vx = 2; a.vy = 1; a.vz = -3;
    expect(totalEnergy([a])).toBe(4 + 1 + 9);
  });
});

describe('SIM defaults', () => {
  it('exposes the tuned force parameters', () => {
    expect(SIM).toMatchObject({ REPEL: 12000, SPRING: 0.022, REST_LEN: 160, DAMPING: 0.76, GRAVITY: 0.006 });
  });
});

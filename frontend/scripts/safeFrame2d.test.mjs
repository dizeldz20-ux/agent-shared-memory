import assert from 'node:assert/strict';
import test from 'node:test';
import { safeFrame2D } from '../src/anatomical2d.ts';

const VIEWPORT = { width: 1600, height: 900, safeTop: 104, bottomPadding: 24 };

/** Where a graph point lands on screen for a given centerAt/zoom frame. */
function project(point, frame, viewport) {
  return {
    x: viewport.width / 2 + (point.x - frame.x) * frame.k,
    y: viewport.height / 2 + (point.y - frame.y) * frame.k,
  };
}

function spread() {
  const nodes = [];
  for (let i = 0; i < 400; i++) {
    nodes.push({ x: Math.cos(i) * 620 + 40, y: Math.sin(i * 1.7) * 480 - 90, kind: 'file', __degree: 2 });
  }
  return nodes;
}

test('safeFrame2D keeps every node below the header and inside the canvas', () => {
  const nodes = spread();
  const frame = safeFrame2D(nodes, VIEWPORT);
  for (const node of nodes) {
    const screen = project(node, frame, VIEWPORT);
    assert.ok(screen.y >= VIEWPORT.safeTop, `node above header band: ${screen.y}`);
    assert.ok(screen.y <= VIEWPORT.height - VIEWPORT.bottomPadding, `node below canvas: ${screen.y}`);
    assert.ok(screen.x >= 0 && screen.x <= VIEWPORT.width, `node outside width: ${screen.x}`);
  }
});

test('safeFrame2D centers the brain in the visible band, not the raw canvas', () => {
  const nodes = spread();
  const frame = safeFrame2D(nodes, VIEWPORT);
  const ys = nodes.map((n) => project(n, frame, VIEWPORT).y);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const bandCenter = VIEWPORT.safeTop + (VIEWPORT.height - VIEWPORT.safeTop - VIEWPORT.bottomPadding) / 2;
  assert.ok(Math.abs(mid - bandCenter) < 1.5, `band center ${bandCenter} vs graph mid ${mid}`);
});

test('re-framing on settled positions recovers a brain that outgrew its targets', () => {
  // Charge repulsion pushes somas past their anatomical targets; a frame built
  // from targets alone clips, and re-framing on the settled spread must fix it.
  const targets = spread();
  const settled = targets.map((n) => ({ ...n, x: n.x * 1.35, y: n.y * 1.35 }));

  const targetFrame = safeFrame2D(targets, VIEWPORT);
  const clipped = settled.filter((n) => project(n, targetFrame, VIEWPORT).y < VIEWPORT.safeTop);
  assert.ok(clipped.length > 0, 'fixture must actually overflow, or this test proves nothing');

  const settledFrame = safeFrame2D(settled, VIEWPORT);
  for (const node of settled) {
    const screen = project(node, settledFrame, VIEWPORT);
    assert.ok(screen.y >= VIEWPORT.safeTop, `settled node clipped by header: ${screen.y}`);
    assert.ok(screen.y <= VIEWPORT.height - VIEWPORT.bottomPadding, `settled node past bottom: ${screen.y}`);
  }
});

test('safeFrame2D is deterministic and independent of node order', () => {
  const nodes = spread();
  const a = safeFrame2D(nodes, VIEWPORT);
  const b = safeFrame2D([...nodes].reverse(), VIEWPORT);
  assert.deepEqual(a, b);
});

test('safeFrame2D survives degenerate input without producing a broken zoom', () => {
  for (const nodes of [[], [{ x: 5, y: 5 }], [{ x: NaN, y: 2 }, { x: 1, y: 1 }]]) {
    const frame = safeFrame2D(nodes, VIEWPORT);
    assert.ok(Number.isFinite(frame.x) && Number.isFinite(frame.y), JSON.stringify(frame));
    assert.ok(Number.isFinite(frame.k) && frame.k > 0, JSON.stringify(frame));
  }
  const tiny = safeFrame2D(spread(), { width: 320, height: 200, safeTop: 400, bottomPadding: 400 });
  assert.ok(Number.isFinite(tiny.k) && tiny.k > 0, JSON.stringify(tiny));
});

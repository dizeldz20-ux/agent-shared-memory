import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NEURON_GLOW,
  luminance,
  mixColor,
  neuronRamp,
  neuronSpriteKey,
  paintNeuron,
  rgba,
} from '../src/neuronSprite.ts';

const LAYERS = ['#33B1FF', '#51D5A5', '#F5ACA3', '#E9B949', '#9EA5AD'];
const STATES = ['idle', 'focus', 'active', 'picked'];

test('mixColor blends between the endpoints and clamps', () => {
  assert.equal(mixColor('#000000', '#FFFFFF', 0), 'rgb(0,0,0)');
  assert.equal(mixColor('#000000', '#FFFFFF', 1), 'rgb(255,255,255)');
  assert.equal(mixColor('#000000', '#FFFFFF', 0.5), 'rgb(128,128,128)');
  assert.equal(mixColor('#000000', '#FFFFFF', 5), 'rgb(255,255,255)');
  assert.equal(mixColor('#000000', '#FFFFFF', -3), 'rgb(0,0,0)');
  assert.equal(mixColor('not-a-colour', '#FFFFFF', 0), 'rgb(158,165,173)');
});

test('every soma body ramp runs bright core to shaded rim', () => {
  for (const color of LAYERS) {
    for (const state of STATES) {
      const { body } = neuronRamp(color, state);
      const lums = body.map(([, value]) => luminance(value));
      for (let i = 1; i < lums.length; i++) {
        assert.ok(lums[i] < lums[i - 1], `${color}/${state} stop ${i} is not darker than the previous`);
      }
      assert.ok(lums[0] - lums.at(-1) > 0.25, `${color}/${state} has too little depth: ${lums[0]} -> ${lums.at(-1)}`);
      assert.deepEqual(body.map(([stop]) => stop), [0, 0.34, 0.72, 1]);
    }
  }
});

test('glow is additive-safe: it fades to fully transparent at the sprite edge', () => {
  for (const state of STATES) {
    const { glow } = neuronRamp('#33B1FF', state);
    assert.equal(glow.at(-1)[0], 1);
    assert.match(glow.at(-1)[1], /,0\)$/);
    assert.ok(NEURON_GLOW > 1, 'glow needs room outside the body');
  }
});

test('picked and active somas read louder than idle', () => {
  const idle = neuronRamp('#33B1FF', 'idle');
  const picked = neuronRamp('#33B1FF', 'picked');
  assert.equal(idle.contour, null);
  assert.ok(picked.contour);
  assert.ok(neuronRamp('#33B1FF', 'active').contour);
  assert.ok(picked.rimWidth > idle.rimWidth);
});

test('sprite keys separate every colour, state, and core variant', () => {
  const keys = new Set();
  for (const color of LAYERS) for (const state of STATES) for (const core of [true, false]) {
    keys.add(neuronSpriteKey(color, state, core));
  }
  assert.equal(keys.size, LAYERS.length * STATES.length * 2);
});

test('paintNeuron issues a hollow membrane / halo / focus-core pass', () => {
  const calls = [];
  const gradient = () => ({ addColorStop: (stop, value) => calls.push(['stop', stop, value]) });
  const ctx = new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'createRadialGradient') return (...a) => { calls.push(['gradient', ...a]); return gradient(); };
      if (typeof prop === 'string' && ['clearRect', 'beginPath', 'arc', 'fill', 'stroke'].includes(prop)) {
        return (...a) => calls.push([prop, ...a]);
      }
      return undefined;
    },
    set: (_, prop, value) => { calls.push(['set', prop, value]); return true; },
  });

  paintNeuron(ctx, '#33B1FF', 'picked', true);
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('clearRect'), 'sprite must start from a clean canvas');
  assert.equal(names.filter((n) => n === 'gradient').length, 2, 'halo and focus core only');
  assert.ok(names.filter((n) => n === 'fill').length >= 2);
  assert.ok(names.filter((n) => n === 'stroke').length >= 2, 'rim light plus picked contour');
  const composites = calls.filter((c) => c[0] === 'set' && c[1] === 'globalCompositeOperation').map((c) => c[2]);
  assert.ok(composites.includes('lighter'), 'glow must be additive');
  assert.equal(composites.at(-1), 'source-over', 'composite must be restored for the next node');
});

test('rgba survives a malformed colour instead of emitting invalid CSS', () => {
  assert.equal(rgba('#33B1FF', 0.5), 'rgba(51,177,255,0.5)');
  assert.equal(rgba('oops', 0.5), 'rgba(158,165,173,0.5)');
});

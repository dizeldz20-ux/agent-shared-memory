import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_AGENT_PALETTES,
  liveAgentLane,
  liveAgentPalette,
} from '../src/liveAgentPalette.ts';

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
  return channels
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

test('Claude uses one readable system-green identity in every live renderer', () => {
  assert.equal(liveAgentLane('Claude Code'), 'claude');
  assert.equal(liveAgentPalette('claude'), LIVE_AGENT_PALETTES.claude);
  assert.deepEqual(LIVE_AGENT_PALETTES.claude, {
    soma: '#8fe0b5',
    route: '#56ad85',
    head: '#d9fbea',
    trail: '#69cca0',
    trace: 'rgba(105, 204, 160, .8)',
  });
  assert.notEqual(LIVE_AGENT_PALETTES.claude.route, LIVE_AGENT_PALETTES.codex.route);
  assert.ok(relativeLuminance(LIVE_AGENT_PALETTES.claude.soma) > 0.55);
  assert.ok(relativeLuminance(LIVE_AGENT_PALETTES.claude.head) > 0.85);
});

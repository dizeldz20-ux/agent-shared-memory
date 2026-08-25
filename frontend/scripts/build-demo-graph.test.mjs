import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeGraph } from './build-demo-graph.mjs';

const input = {
  nodes: [
    { id: 'vault:secret-note', label: 'Customer secret', layer: 'vault', kind: 'page', path: 'private/customer.md', abs: 'C:/Users/User/private/customer.md', meta: { description: 'private text', tags: ['secret'] } },
    { id: 'api:src/api.py', label: 'api.py', layer: 'api', kind: 'file', path: 'src/api.py', abs: 'C:/Users/User/src/api.py' },
    { id: 'api:root', label: 'API', layer: 'api', kind: 'root', path: '', abs: '' },
  ],
  links: [
    { source: 'vault:secret-note', target: 'api:src/api.py', type: 'xlayer' },
    { source: { id: 'api:root' }, target: { id: 'api:src/api.py' }, type: 'contains', weight: 2 },
  ],
};

test('sanitizeGraph preserves topology while removing private identity', () => {
  const { graph, events } = sanitizeGraph(input);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.links.length, 2);
  assert.deepEqual(graph.nodes.map((node) => node.id), ['n0', 'n1', 'n2']);
  assert.ok(graph.nodes.every((node) => node.kind === 'root' ? node.path === '' : node.path.startsWith('demo/')));
  assert.ok(graph.nodes.every((node) => !('abs' in node) && !('meta' in node)));
  assert.ok(graph.links.every((link) => /^n\d+$/.test(link.source) && /^n\d+$/.test(link.target)));
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.path.startsWith('demo/')));
  const serialized = JSON.stringify({ graph, events });
  for (const forbidden of ['Customer secret', 'private/customer.md', 'C:/Users/User', 'vault:secret-note', 'api.py', 'private text', 'secret']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('sanitizeGraph keeps public layer roots recognizable', () => {
  const { graph } = sanitizeGraph(input);
  assert.equal(graph.nodes.find((node) => node.kind === 'root')?.label, 'API');
});

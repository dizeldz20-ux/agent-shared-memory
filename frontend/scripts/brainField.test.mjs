import assert from 'node:assert/strict';
import test from 'node:test';
import {
  corticalFiberPositions,
  corticalFieldPositions,
  corticalMeshData,
  fieldDigest,
  neuronMorphologyPositions,
  translateNeuronMorphology,
} from '../src/brainField.ts';

test('cortical field is deterministic, bounded, bilateral, and opens an upper fissure', () => {
  const field = corticalFieldPositions(5200);
  const again = corticalFieldPositions(5200);
  assert.equal(field.length, 15600);
  assert.equal(fieldDigest(field), fieldDigest(again));
  assert.match(fieldDigest(field), /^[a-f0-9]{8}$/);

  let left = 0;
  let right = 0;
  let upperNearCenter = 0;
  for (let index = 0; index < field.length; index += 3) {
    const [x, y, z] = [field[index], field[index + 1], field[index + 2]];
    assert.ok(Math.abs(x) <= 230, `x ${x}`);
    assert.ok(Math.abs(y) <= 150, `y ${y}`);
    assert.ok(Math.abs(z) <= 190, `z ${z}`);
    if (z < 0) left++;
    else right++;
    if (y > 15 && Math.abs(z) < 4) upperNearCenter++;
  }
  assert.ok(Math.abs(left - right) < 30, `${left}/${right}`);
  assert.ok(upperNearCenter < 10, `fissure contains ${upperNearCenter} points`);
});

test('cortical fibers are deterministic line segments spanning both hemispheres', () => {
  const fibers = corticalFiberPositions(30, 34);
  assert.equal(fibers.length % 6, 0);
  assert.ok(fibers.length > 10000);
  assert.equal(fieldDigest(fibers), fieldDigest(corticalFiberPositions(30, 34)));
  let left = false;
  let right = false;
  for (let index = 2; index < fibers.length; index += 3) {
    if (fibers[index] < -8) left = true;
    if (fibers[index] > 8) right = true;
  }
  assert.ok(left && right);
});

test('living cortex mesh and batched neuron morphology are deterministic and finite', () => {
  const mesh = corticalMeshData(20, 32);
  assert.equal(mesh.positions.length, (20 + 1) * (32 + 1) * 3);
  assert.equal(mesh.indices.length, 20 * 32 * 6);
  assert.ok([...mesh.positions].every(Number.isFinite));
  assert.ok([...mesh.indices].every((index) => index >= 0 && index < mesh.positions.length / 3));

  const anchors = Array.from({ length: 80 }, (_, index) => ({
    id: `node:${index}`,
    kind: index % 13 === 0 ? 'root' : index % 5 === 0 ? 'dir' : 'file',
    x: index - 40,
    y: Math.sin(index) * 20,
    z: Math.cos(index) * 30,
  }));
  const morphology = neuronMorphologyPositions(anchors, 32);
  const again = neuronMorphologyPositions([...anchors].reverse(), 32);
  assert.equal(morphology.neuronCount, 32);
  assert.ok(morphology.segments.length > morphology.synapses.length);
  assert.equal(morphology.segments.length % 6, 0);
  assert.equal(morphology.synapses.length % 3, 0);
  assert.equal(morphology.ranges.length, morphology.neuronCount);
  assert.deepEqual(morphology.ranges, again.ranges);
  assert.equal(morphology.ranges[0].segmentStart, 0);
  assert.equal(morphology.ranges.at(-1).segmentEnd, morphology.segments.length);
  assert.equal(morphology.ranges.at(-1).synapseEnd, morphology.synapses.length);
  assert.equal(fieldDigest(morphology.segments), fieldDigest(again.segments));
  assert.ok([...morphology.segments, ...morphology.synapses].every(Number.isFinite));
});

test('dragged soma translation keeps its batched dendrites and synapses attached', () => {
  const morphology = neuronMorphologyPositions([
    { id: 'root', kind: 'root', x: 0, y: 0, z: 0 },
    { id: 'dir', kind: 'dir', x: 40, y: 20, z: -10 },
  ], 2);
  const segments = morphology.segments.slice();
  const synapses = morphology.synapses.slice();
  const beforeSegments = segments.slice();
  const beforeSynapses = synapses.slice();
  const range = morphology.ranges[0];
  assert.equal(translateNeuronMorphology(segments, synapses, range, 3, -2, 5), true);
  for (let index = range.segmentStart; index < range.segmentEnd; index += 3) {
    assert.ok(Math.abs(segments[index] - beforeSegments[index] - 3) < 1e-5);
    assert.ok(Math.abs(segments[index + 1] - beforeSegments[index + 1] + 2) < 1e-5);
    assert.ok(Math.abs(segments[index + 2] - beforeSegments[index + 2] - 5) < 1e-5);
  }
  for (let index = range.synapseStart; index < range.synapseEnd; index += 3) {
    assert.ok(Math.abs(synapses[index] - beforeSynapses[index] - 3) < 1e-5);
    assert.ok(Math.abs(synapses[index + 1] - beforeSynapses[index + 1] + 2) < 1e-5);
    assert.ok(Math.abs(synapses[index + 2] - beforeSynapses[index + 2] - 5) < 1e-5);
  }
  const untouched = morphology.ranges[1];
  assert.deepEqual(
    [...segments.slice(untouched.segmentStart, untouched.segmentEnd)],
    [...beforeSegments.slice(untouched.segmentStart, untouched.segmentEnd)],
  );
});

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT_LABELS = {
  vault: 'כספת הידע',
  api: 'API',
  web: 'Web',
  ops: 'Ops',
  lab: 'Lab',
  asm: 'ASM',
  agents: 'Agents',
  skills: 'Skills',
  acp: 'ACP',
  ephemeral: 'מחוץ למפה',
};

const KIND_LABELS = {
  page: 'זיכרון',
  file: 'נוירון קוד',
  dir: 'אשכול',
  ephemeral: 'אות זמני',
  root: 'ליבה',
};

function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}

export function sanitizeGraph(input) {
  const nodesIn = Array.isArray(input?.nodes) ? input.nodes : [];
  const linksIn = Array.isArray(input?.links) ? input.links : [];
  const idMap = new Map(nodesIn.map((node, index) => [node.id, `n${index}`]));
  const counters = new Map();

  const nodes = nodesIn.map((node, index) => {
    const layer = node.layer === 'c2b' ? 'asm' : node.layer;
    const key = `${layer}:${node.kind}`;
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    const label = node.kind === 'root'
      ? (ROOT_LABELS[layer] ?? 'ליבה')
      : `${KIND_LABELS[node.kind] ?? 'צומת'} ${String(count).padStart(3, '0')}`;
    const demoPath = node.kind === 'file' || node.kind === 'page'
      ? `demo/${layer}/${node.kind}-${String(count).padStart(3, '0')}.${node.kind === 'page' ? 'md' : 'ts'}`
      : '';
    return { id: `n${index}`, label, layer, kind: node.kind, path: demoPath };
  });

  const links = linksIn.flatMap((link) => {
    const source = idMap.get(endpointId(link.source));
    const target = idMap.get(endpointId(link.target));
    if (!source || !target) return [];
    return [{ source, target, type: link.type, ...(Number.isFinite(link.weight) ? { weight: link.weight } : {}) }];
  });

  const demoNodes = nodes.filter((node) => node.kind === 'file' || node.kind === 'page').slice(0, 18);
  const events = demoNodes.map((node, index) => ({
    ts: index,
    tool: index % 3 === 0 ? 'Read' : index % 3 === 1 ? 'Edit' : 'Grep',
    cwd: 'demo',
    session: 'demo',
    agent: index % 2 === 0 ? 'Codex' : 'Claude Code',
    path: node.path,
    node_id: node.id,
    matched: true,
    layer: node.layer,
    label: node.label,
  }));

  return { graph: { nodes, links }, events };
}

async function main() {
  const source = new URL('../../data/brain.json', import.meta.url);
  const outputDir = new URL('../public/demo/', import.meta.url);
  const input = JSON.parse(await readFile(source, 'utf8'));
  const { graph, events } = sanitizeGraph(input);
  await mkdir(fileURLToPath(outputDir), { recursive: true });
  await writeFile(new URL('brain.json', outputDir), JSON.stringify(graph), 'utf8');
  await writeFile(new URL('events.json', outputDir), JSON.stringify(events), 'utf8');
  process.stdout.write(`sanitized ${graph.nodes.length} nodes / ${graph.links.length} links / ${events.length} demo events\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

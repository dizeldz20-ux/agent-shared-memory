import type { BrainNode, LiveActivitySource, LiveEvent } from './types';
import { agentLane } from './liveRoster';

// The lane function lives with the roster that defines agent identity; it is
// re-exported here so every existing caller keeps one import site.
export { agentLane };

export interface LiveFileActivity {
  event: LiveEvent;
  count: number;
  key: string;
}

const FILE_EXTENSIONS = new Set([
  'astro', 'bash', 'bazel', 'bzl', 'c', 'cc', 'cjs', 'conf', 'cpp', 'cs', 'css', 'csv', 'cts', 'dart',
  'env', 'excalidraw', 'go', 'gql', 'gradle', 'graphql', 'h', 'hpp', 'html',
  'ini', 'ipynb', 'java', 'js', 'json', 'jsonl', 'jsx', 'kt', 'lock', 'lua', 'md',
  'mdx', 'mjs', 'php', 'prisma', 'properties', 'proto', 'ps1', 'py', 'r', 'rb',
  'rs', 'scss', 'sh', 'sol', 'sql', 'svelte', 'svg', 'swift', 'tf', 'tfvars',
  'toml', 'ts', 'tsx', 'txt', 'mts', 'vue', 'wasm', 'xml', 'yaml', 'yml', 'zsh',
]);

const EXTENSIONLESS_FILES = new Set([
  'authors', 'brewfile', 'build', 'buck', 'changelog', 'cmakelists', 'contributing',
  'dockerfile', 'gemfile', 'justfile', 'license', 'makefile', 'notice', 'procfile',
  'rakefile', 'readme', 'vagrantfile', 'workspace',
]);

const DOT_FILES = new Set([
  '.dockerignore', '.editorconfig', '.env', '.gitattributes', '.gitignore',
  '.npmrc', '.nvmrc', '.prettierignore', '.prettierrc', '.tool-versions',
]);

/** Drop finished signal state even when no later WebSocket frame arrives. */
export function pruneExpiredLiveState(
  now: number,
  active: Map<string, number>,
  activeAgents: Map<string, string>,
  activeSources: Map<string, LiveActivitySource>,
) {
  let removed = 0;
  for (const [nodeId, until] of active) {
    if (until > now) continue;
    active.delete(nodeId);
    activeAgents.delete(nodeId);
    removed += 1;
  }
  for (const [key, source] of activeSources) {
    if (source.until > now) continue;
    activeSources.delete(key);
    removed += 1;
  }
  return removed;
}

export function liveAction(tool: string) {
  if (/apply_patch|edit|write/i.test(tool)) return 'EDITING';
  if (/read|view/i.test(tool)) return 'READING';
  if (/bash|exec|shell/i.test(tool)) return 'READ / RUN';
  if (/test/i.test(tool)) return 'TESTING';
  if (/web|search/i.test(tool)) return 'SEARCHING';
  if (/plan/i.test(tool)) return 'PLANNING';
  return (tool || 'ACTIVE').toUpperCase();
}

export function liveFilePath(event: LiveEvent) {
  const normalized = (event.path || '').replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const projectsIndex = parts.lastIndexOf('Projects');
  if (projectsIndex >= 0) return parts.slice(projectsIndex).join('/');
  return parts.slice(-5).join('/') || event.label || 'unknown file';
}

/** Replace noisy shell-extracted paths with the canonical path already in ASM. */
export function canonicalLiveEvent(event: LiveEvent, nodes: Map<string, BrainNode>) {
  const node = nodes.get(event.node_id);
  if (!event.matched || !node) return event;
  return {
    ...event,
    path: node.abs || node.path || event.path,
    label: node.label || event.label,
    layer: node.layer || event.layer,
  };
}

function pathLooksLikeFile(path: string) {
  const normalized = path.trim().replaceAll('\\', '/');
  if (!normalized || normalized.length > 1200) return false;
  // Shell fragments such as `m.role`, `(raw.chats`, pipes and globs are not
  // file access. The hook also filters these; this guard protects old runtimes
  // and historical frames until every agent has reloaded the current hook.
  if (/[\x00\r\n`'"*?{}\[\]()$=<>|;&]/.test(normalized)) return false;
  const leaf = normalized.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
  if (!leaf) return false;
  if (DOT_FILES.has(leaf) || leaf.startsWith('.env.') || EXTENSIONLESS_FILES.has(leaf)) return true;
  const extension = leaf.match(/\.([a-z0-9]{1,16})$/i)?.[1]?.toLowerCase();
  return Boolean(extension && FILE_EXTENSIONS.has(extension));
}

function pathLooksLikeResolvedAccess(path: string) {
  const normalized = path.trim().replaceAll('\\', '/');
  if (!normalized || normalized.length > 1200 || normalized.endsWith('/')) return false;
  if (/[\x00\r\n`'"*?{}\[\]()$=<>|;&]/.test(normalized)) return false;
  const leaf = normalized.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
  if (!leaf || leaf === '.' || leaf === '..') return false;
  return leaf.startsWith('.') || leaf.includes('.') || EXTENSIONLESS_FILES.has(leaf);
}

/** Only file/page access enters the visual flow; presence and build noise stay out. */
export function isFileAccessEvent(event: LiveEvent, nodes: Map<string, BrainNode>) {
  if (event.presence || !event.path?.trim()) return false;
  const node = nodes.get(event.node_id);
  if (event.matched && node) return node.kind === 'file' || node.kind === 'page';
  // Current adapters resolve direct arguments and shell tokens against the
  // filesystem before setting file_access. This safely covers real files such
  // as Brewfile, .python-version and Dockerfile.dev without accepting legacy
  // shell fragments from older hook versions.
  if (event.file_access) return pathLooksLikeResolvedAccess(event.path);
  return pathLooksLikeFile(event.path);
}

/**
 * Group file access by agent — newest first, repeats folded into a count.
 *
 * There is no cross-agent competition for rows any more, because the trace draws
 * one group per agent and caps each on its own. The flat list this replaced had
 * to decide how much of itself each agent deserved, and its answer — one
 * reserved row per agent regardless of age — is exactly what let a single Codex
 * touch from ninety seconds ago sit beside Claude's current work, drawn the same
 * and carrying no age of its own.
 */
export function laneFileActivity(source: LiveEvent[], perLane: number) {
  const grouped = new Map<string, LiveFileActivity>();
  for (const event of [...source].sort((a, b) => b.ts - a.ts)) {
    const lane = agentLane(event.agent);
    const fileIdentity = event.matched
      ? event.node_id
      : event.path.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase();
    const key = `${lane}:${fileIdentity}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { event, count: 1, key });
  }

  const lanes = new Map<string, LiveFileActivity[]>();
  for (const item of grouped.values()) {
    const lane = agentLane(item.event.agent);
    const entries = lanes.get(lane) ?? [];
    entries.push(item);
    lanes.set(lane, entries);
  }
  for (const [lane, entries] of lanes) {
    lanes.set(lane, entries.sort((a, b) => b.event.ts - a.event.ts).slice(0, perLane));
  }
  return lanes;
}

/** Merge raw file access while replacing PreToolUse with its matching finish event. */
export function mergeFileEvents(incoming: LiveEvent[], previous: LiveEvent[], limit = 500) {
  const seen = new Set<string>();
  return [...incoming, ...previous]
    .sort((a, b) => b.ts - a.ts
      || Number(b.phase === 'finish') - Number(a.phase === 'finish'))
    .filter((event) => {
      const key = liveEventKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function liveEventKey(event: LiveEvent) {
  return event.operation_id
    ? `${agentLane(event.agent)}:${event.session}:${event.operation_id}:${event.path}`
    : `${agentLane(event.agent)}:${event.ts}:${event.session}:${event.tool}:${event.node_id}:${event.path}`;
}

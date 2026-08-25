# ASM, the vault, and the mission graph

Read this at the start of every graph mission. Four different kinds of state cooperate, but they are not interchangeable.

| Layer | Purpose | Freshness |
|---|---|---|
| ASM brain graph | Joins mapped code, vault pages, relationships, and discoverable memories | Snapshot rebuilt by `refresh.sh` |
| ASM immediate memory | Append-only cross-agent handoffs in `~/.asm/memory.jsonl` | Immediate |
| Obsidian vault | Canonical human-maintained decisions, gotchas, architecture, and history | Durable; enters the brain after OKF rebuild/refresh |
| Mission graph | Dependencies, ownership, status, and evidence for the current request | Ephemeral; optionally persisted under `.codex/graph-runs/` |

Current source files, tests, running systems, and authoritative external sources remain the truth for current behavior. Recall supplies context and traps; it does not waive present-state inspection.

## Recall order

1. Search the subject with `brain_search`. Query `memory_recent` when a recent Claude/Codex handoff may be newer than the graph snapshot.
2. Before reading or editing a mapped target file, call `brain_context` for that path. If it returns relevant `vault_pages`, read those pages before the edit.
3. Use `brain_node`, `brain_neighbors`, or `brain_path` when the mission depends on an exact node, blast radius, or relationship.
4. Read applicable `AGENTS.md` and current project files. Verify dated memory facts against current state before making a node depend on them.
5. Only when ASM did not answer the knowledge question, descend to the generated vault index/catalog, project-specific code-graph tools, and finally `rg`/file inspection for discovery.

Do not hand a child agent only a path. Include the relevant recall facts and their sources, or require the agent to run the same recall for its exact file scope.

## Recall pack

Keep 3-8 facts that change the plan. Every fact carries a source:

- `asm:<node-id>` for an ASM graph node
- `memory:<record-id>` for an immediate handoff
- `vault:<page-id>` for canonical vault knowledge
- `file:<path>#L<n>` for current local evidence
- `cmd:<command>` for observed command output
- `url:<canonical-url>` for an authoritative external source

An unsourced assertion is a hypothesis. Turn it into a discovery or verification node instead of copying it into worker prompts as fact.

## Write-back order

After files change, record the verified unit of work with `memory_record`: concrete outcome, direct checks, affected files, decisions, open threads, agent name, and the session id supplied by the ASM gate. If no gate id is available, use one unique descriptive id for the run.

Create or update a vault page only for durable architecture, operational rules, traps, or decisions. Obey the vault's `AGENTS.md`, never store secrets or raw private transcripts, and use `contradictions` when a new page supersedes an old one.

Run the ASM refresh after structural code changes or new durable vault pages so the graph catches up. Immediate memory remains searchable before refresh.

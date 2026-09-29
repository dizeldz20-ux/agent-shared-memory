# Operating Environment

What recall, authority and dispatch concretely mean in this stack. Read this at the start of every mission — it is the difference between a generic task graph and one that plans around traps already paid for.

> **Customize this file once.** The recall ladder, the ASM notes, the authority list and the dispatch table work as shipped against a stock ASM install. The **Traps** section is deliberately a stub: fill it with your own hard-won lessons, one line each, and the graph will plan around them instead of walking into them. That section is what makes this skill yours. Then swap the agent types in the dispatch table for the ones your installation has.

**Last verified against your stack:** [date, and the ASM commit or version you run]. Update this file when a memory or ASM tool is renamed or retired, when your ASM version ships another layer, when a trap is added or retired, or when the machine or the test path changes. A tool named here that the session cannot call is a stale line — fix the line, do not route around it silently.

## Knowledge Layers

| Layer | What it holds | Freshness |
|-------|---------------|-----------|
| ASM brain graph | Vault pages, code mapped by graphify at file level, agent records as `memory:<id>` nodes, and the edges between them | Snapshot from the last refresh; the SessionStart banner warns once it is 3 or more days old. A running MCP may keep serving the graph it loaded until the session restarts |
| ASM records | Handoffs from every agent session that records to ASM (`~/.asm/memory.jsonl`), each with its open threads. If your ASM version numbers threads, each has an id `<record-id>#<n>`, with `<n>` counting from 0 | Immediate |
| ASM lifecycle ledger — only if your ASM version ships one | Closed threads, finished plan pages, and requested corrections. Recall then hides closed threads, and a finished vault plan page is marked `[DONE dd/mm · evidence]`; `memory_recent` marks nothing | Immediate |
| Agent memory | The memory index loaded into every session (`MEMORY.md`: standing rules, tool traps) → a hub page per project, if you keep them → memory files | Hand-kept, dated |
| The vault | Canonical decisions, gotchas, architecture — `wiki/main/` in your Obsidian vault | Durable; enters the graph on refresh |
| Live state | Files, git, running hosts, command output | The only truth for "now" |

Recall supplies context and traps. It never replaces checking live state for anything a node depends on.

## The Recall Ladder

Climb down. A question is answered when the fact is known **and** any state it asserts — deployed, pending, a flag value, a commit — has been checked live or turned into a `recon` node. Only then stop.

| Rung | Source | How |
|------|--------|-----|
| 0 | Already in context | ASM's hook output — the prompt hook's "ASM recall" nodes, the skill-router hints, the SessionStart banner (open threads; a stale-graph warning at 3+ days) — and the memory index. Open a listed node with `mcp__asm__brain_node(node_id)`. A prompt that starts with `/` — `/graph-mission …` included — gets no prompt-hook recall and no router hints, so recall starts at rung 1. A subagent gets no recall output (router hints may still arrive), so it starts at rung 1 too |
| 1 | ASM search | `mcp__asm__brain_search(query=<topic>)` across vault pages, mapped code and records. `mcp__asm__memory_recent(limit=5, query=<one or two distinctive words>)` for handoffs newer than the graph, with their open threads |
| 2 | The project's memory | The hub or page the memory index names for the project, then the memory files the task touches |
| 3 | ASM per file | `mcp__asm__brain_context(file_path)` before the first Read or Edit of a mapped file; read its `vault_pages` before editing. The code graph is graphify's, inside the brain: `mcp__asm__brain_neighbors(node_id, depth)` for a shared change's blast radius, `mcp__asm__brain_path(from_id, to_id)` for how two nodes relate. The graph is file-level, and `brain_neighbors` stops at depth 3 and 50 nodes, so on a hub file the blast radius is partial. A repo-relative path resolves only when exactly one mapped checkout ends with it; when ASM maps several copies it returns `node: null` — pass the mapped checkout's absolute path. If your ASM version resolves worktrees (the answer carries `resolved_via`), pass the worktree's absolute path as is |
| 4 | Disk | grep / find / Read — for what rungs 0-3 did not answer, for page bodies, and for vault pages newer than the graph |

**ASM returns metadata.** `brain_search`, `brain_node` and `brain_context` return descriptions and paths, not page bodies. Read the page from disk for its body.

**Memories and records are dated snapshots.** A line naming a file, flag, port, commit or deploy state records what was true when it was written.

## ASM Behavior to Plan Around

What shapes a mission, whichever ASM version you run:

- **Check a tool's parameters before relying on a newer feature.** `memory_record` takes `session_id`, `summary`, `details`, `files`, `decisions`, `open_threads`, `agent` and `supersedes`. If your ASM version's `memory_record` also accepts `resolves` and `corrects`, the write-back uses them. A session that started before an ASM upgrade still runs the old MCP — check the parameters this session actually sees.
- **`brain_context` can return `node: null`** for a path that is ambiguous or not mapped at all. Retry with more path segments, then `brain_search` the subject. Null never means "nothing is known".
- **Ask for little, and precisely.** Call `memory_recent` with a `limit` of 5 or less and a `query` of one or two distinctive words: depending on your ASM version, `query` matches records that contain every word (AND) or any word (OR), so a long query finds either nothing or everything. Records are long, and if your ASM version caps the output at a character budget (20,000 characters, say), a wide call is cut exactly where you needed it. On a version that returns whole records, `brain_context` on a busy file carries up to 10 and can exceed the client's result limit — fall back to `brain_search` plus `brain_node`. A capped version returns at most 3 record briefs; open one with `brain_node("memory:<id>")`.
- **A status line is a snapshot.** "Not deployed", "pending", "waiting for the user" in a record or a hub is still a snapshot to verify live. If your ASM version ranks results by recency, that is a nudge, not a filter.
- **Finished threads do not close themselves.** If your ASM version tracks thread closure (a lifecycle ledger), a closed thread leaves recall, a finished vault plan page is marked `[DONE dd/mm · evidence]` — `memory_recent` marks nothing — and a mission closes what it finished through its write-back. Without one, a thread stays in recall until a later record supersedes the record that opened it — so an open thread in recall is a lead to check, not proof the work is still open.
- **The graph lags; records do not.** Today's work is in `memory_recent` before it is in the graph. `refresh.sh` (`refresh.ps1` on Windows) rebuilds the graph, and it also copies the checkout's `mcp_server.py`, hooks and skills into the shared runtime — `~/.asm`, `~/.asm/hooks`, `~/.agents/skills` and `~/.claude/skills` — so a run from an old checkout downgrades every session. It is a `gate` unless `cmp` shows the checkout's `mcp_server.py`, `hook/*.js` and `skills/` equal the deployed copies in `~/.asm`, `~/.asm/hooks` and the installed skill folders — skills too, or a branch that still carries an older skill overwrites the installed one. Either way, a mission runs it only when the mission is about ASM and no other session is working on ASM, and the node holds `asm-refresh`.

## Traps That Must Shape the Graph

Already-paid-for lessons, each with the memory that records it. If a node's success criterion contradicts one of them, the criterion is wrong — fix it at compile time.

**Replace these examples with your own** — each line names the trap and cites the memory or vault page that records it. The Right Path section of `checklists/evidence-gate.md` mirrors this list; keep the two in sync.

- **Tests run through the project's real test path — targeted, capped, and one run at a time.** A runner invoked the convenient way produces a green run that proves nothing, and two runs at once starve the machine. A subagent runs targeted files only, with a low worker count; the full suite runs only at the end of a stage — in the `verify` before work lands, or the final `verify` — alone. Every node that runs tests, the primary agent's re-runs included, holds the `test-runner` lock. (`your-memory-page`)
- **Behavior and hardening are verified on the live path only.** Reading code, loopback calls, or a fixture with injected env all fake success. (`your-memory-page`)
- **An LLM path is verified by a direct call with no fallback.** A "weak" run is a rate limit or a silent fallback until the audit says otherwise. (`your-memory-page`)
- **UI is verified by driving the running app** — browser automation or Playwright against the real build — not by reading component source. (`your-memory-page`)
- **Edit the task's own local tree, never a production checkout.** A checkout shared by parallel sessions, worktrees that multiply, and second copies of a project exist more often than you think: one worktree per session, and confirm which tree the task belongs to before editing. (`your-memory-page`)
- **A service started for a check is stopped by the node that started it.** Nothing that already runs in production is started locally. (`your-memory-page`)
- **Work lands on the branch the mission hands over only after an adversarial multi-agent review.** Working commits on lane and integration branches come before it. (`your-memory-page`)
- **Network git and credentialed calls take the sanctioned path** — whatever your agent's sandbox documents for them — and a token is never written to a file. (`your-memory-page`)
- **Scheduled jobs run with less than your shell has.** A job started by launchd, cron or Task Scheduler gets almost no `PATH` and may be denied the folders your projects live in. (`your-memory-page`)

## Authority

These wait for the user, and in a graph each one is a `gate`:

- deploy, push, or an outbound message
- spending money
- using a credential — reading, copying or passing a secret, or signing in to an outside service as the user. Running an app with the keys it already has configured is not
- anything that drives the user's screen
- changing a runtime every session shares — the shared-memory runtime (code, configuration, hooks or jobs in `~/.asm`), global hooks, agent settings such as `~/.claude/settings.json`, and scheduled jobs (launchd, cron, systemd timers). Data written through ASM's own tools, such as `memory_record`, is not a runtime change. `refresh.sh` redeploys this runtime, so it is a `gate` unless the `cmp` check in ASM Behavior to Plan Around shows the deployed copies already match
- a destructive or irreversible operation on anything the mission did not create

A request in the prompt ("…and deploy it") is intent, not the word. At the gate the user sees the evidence, then gives the word — unless they said in so many words to proceed without asking. The word covers that action only.

A decision that the spec, the code or one of the user's earlier decisions already answers is not theirs to repeat: decide, cite the source, move on. Ask only what is genuinely theirs — taste without a rubric, production, money, anything irreversible.

## Dispatch

**Default: the `Agent` tool.** Agents run in the background and notify on completion — do not poll. `SendMessage` continues an agent with its context; a new `Agent` call starts cold. Do not rely on a subagent to spawn subagents.

Agent types by role. Substitute the equivalents your installation actually has — the point is the *pairing*, not the names. The last column comes from each type's tool list, and it decides who can supply live proof: the values below are typical, so check them for your agents.

| Node role | Agent type | Runs commands / reads ASM |
|-----------|-----------|---------------------------|
| Recon, "where is X", broad sweeps | `Explore` | yes / yes |
| Build / general multi-step work | `general-purpose` | yes / yes |
| Architecture blueprint before building | a code-architect agent | no / no |
| Verify — correctness and conventions, by reading code | a code-reviewer agent | no / no |
| Verify — swallowed errors, bad fallbacks | a silent-failure hunter | yes / yes |
| Verify — test coverage of the change | a test-coverage analyzer | yes / yes |
| Verify — security | a security-review agent | yes / no |

Live-path evidence comes from the primary agent or a command-capable agent. A read-only reviewer adds a lens; it never supplies the live proof. What makes a verifier independent is defined once, in `checklists/evidence-gate.md`.

Non-isolated subagents share this session's id and working directory, so the memory gate attributes their file changes to this session. An agent started with `isolation: "worktree"` works on its own branch: its changes are checked in the worktree path it returns, and a `reduce` node merges them.

A `build` node that executes a written plan through a plan-execution skill that dispatches its own agents runs as `self`, holds `test-runner` throughout, and its agents count against `max_subagents`.

**`Workflow` is opt-in only** — when the user said "use a workflow" or named orchestration in their own words. Otherwise mention the option and dispatch with `Agent`.

**Progress:** `TodoWrite` when the session has it; otherwise the run file is the tracker, and each report carries a one-line status ("wave 2 of 3"). When `AskUserQuestion` is missing, as in a subagent, write the question into the brief's blockers and stop.

## Inside Every Node

The project's instruction files (`CLAUDE.md`, `AGENTS.md`) apply to every node, subagents included. A node's `success` criterion doubles as its per-step check. A node whose deliverable is speculative is cut at compile time, not built and then reviewed. Deliberate corner-cuts carry a comment naming the ceiling and the upgrade path. The cheapest architecture that fits wins: three nodes that could be one are ceremony.

The write-back procedure lives in `tasks/run-mission.md`.

## Language

Report to the user in their language. The first line of the brief and of every report is what the user does now; the brief lists at most 5 items per group, with the rest in the run file. Identifiers, paths, commands, file names, and anything whose translation would break something stay in their original form, in backticks. Run files, node ids, plans and subagent prompts stay in English — they are machine surface.

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*

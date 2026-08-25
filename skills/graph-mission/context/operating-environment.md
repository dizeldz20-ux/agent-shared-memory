# Operating Environment

What recall, dispatch, and evidence concretely mean in this stack. Read this at the start of every mission — it is the difference between a generic task graph and one that plans around traps already paid for.

> **Customize this file once.** The recall order and dispatch table below work as shipped. The **Traps** section is deliberately a stub: fill it with your own hard-won lessons, one line each, and the graph will plan around them instead of walking into them. That section is what makes this skill yours.

## Knowledge Stack — the recall order

Never scan code to "remember" something. Recall runs in this order, cheapest first, and stops as soon as it answers:

| Rung | Source | How to reach it | Costs |
|------|--------|-----------------|-------|
| 0 | **ASM shared memory** | `mcp__asm__brain_search(topic)` for a mission subject, `mcp__asm__brain_context(file)` for a file. One call returns the vault pages *and* the code neighbourhood together — it is the merged graph of both, so it usually answers rungs 3 and 4 at once. Skill: `agent-shared-memory` | one call |
| 1 | `MEMORY.md` index | Already in context every session — consult it, do not re-read the file | free |
| 2 | A memory topic file | The file the index line points at; the detail lives there, not in the index | one Read |
| 3 | The vault (source of truth) | Start from the generated index (`okf/index.md`) or the catalog, not from a directory listing | one or two Reads |
| 4 | A code-graph tool | Whatever the project has indexed; returns symbol source plus call paths in one round trip | one call |
| 5 | Grep / Glob / Read | Last resort, and only for what rungs 0-4 did not answer | many calls |

The memory index is a pointer layer, not the knowledge. A line there means "the detail is in that file, and the durable version is in the vault."

**Memories are dated snapshots.** A memory naming a file, flag, or port records what was true when written. Verify it still exists before a node depends on it — a stale memory is a plausible-looking dead end.

## Traps that must shape the graph, not surprise it

These are already-paid-for lessons. A graph that plans around them is the whole reason to compile before executing. **Replace these examples with your own** — each line names the trap and cites the memory or vault page that records it.

- **Tests run only through the project's real test path.** A test runner invoked the convenient way instead of the project's way produces a green run that proves nothing. (`your-memory-page`)
- **Hardening and behavior are verified on the live path only.** Reading code, loopback calls, or a test fixture with injected env all fake success. (`your-memory-page`)
- **An LLM path is verified by a direct call with no fallback.** A "weak" result is a rate limit or a silent fallback until the audit says otherwise. (`your-memory-page`)
- **UI is verified by driving the running app**, not by reading the component source. (`your-memory-page`)
- **Two copies of a project exist more often than you think.** Confirm which tree is live before editing. (`your-memory-page`)
- **Production actions wait for a human.** A deploy node is a node that *stops and asks*, never one that proceeds. (`your-memory-page`)

If a node's success criterion contradicts one of these, the criterion is wrong — fix it at compile time.

## Dispatch — what runs the nodes

**Default: the `Agent` tool.** One subagent per independent node, background, cap 4 concurrent unless the mission argues for more.

Useful agent types, by role. Substitute the equivalents your installation actually has — the point is the *pairing*, not the names:

| Node role | Agent type |
|-----------|-----------|
| Recon, "where is X", broad sweeps | `Explore` |
| Build / general multi-step work | `general-purpose` |
| Architecture blueprint before building | a code-architect agent |
| Evaluator — correctness and conventions | a code-reviewer agent |
| Evaluator — swallowed errors, bad fallbacks | a silent-failure hunter |
| Evaluator — test coverage of the change | a test-coverage analyzer |

Give the evaluator a **different type and different evidence** than the generator. Two agents with the same prompt make the same mistake and agree about it.

**The `Workflow` tool is opt-in only.** Use it when the user asked for orchestration in their own words. A mission that would benefit from it is not permission to run it — mention the option and dispatch with `Agent` instead.

## Laziness applies to the graph too

The cheapest architecture that fits wins. Three nodes that could be one node are not a mission, they are ceremony. A node whose deliverable is speculative gets cut at compile time, not built and then reviewed.

## Write-back — closing the loop

A mission that learned something durable is not done when the code works.

1. Knowledge (bug pattern, setup detail, architecture decision, gotcha, status change) → write the vault page, same session. The vault is the source of truth, and the page becomes a brain node on the next refresh.
2. A cross-session rule that changes how future sessions work → a memory topic file plus one pointer line in the index. Never put the content in the index.
3. When a new page revises an older one, record the superseded page id in `contradictions` instead of overwriting it silently.

## Language

Report to the user in their language. Identifiers, paths, commands, file names, and anything whose translation would break something stay in their original form. Run files, node ids, and subagent prompts stay in English — they are machine surface.

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*

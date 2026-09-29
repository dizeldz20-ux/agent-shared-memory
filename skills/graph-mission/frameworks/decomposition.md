# Decomposition

How to cut a compiled objective into the right nodes. `graph-engineering.md` chooses the topology; this file decides what the nodes are.

Most bad missions are not bad because of the architecture level. They have a node nothing consumes, a build nobody verifies, two lanes fighting over the test runner, or a deploy hidden inside a build step. Each of those is cheap to catch at compile time and expensive to discover mid-run.

## Core Concepts

### Work backwards from the success signal

Start at the check that proves the objective — the terminal check: a `verify`, or, for research and comparisons, the `recon` or `decide` whose sourced claims are the success signal. Ask "what must be true for this check to pass?" Each answer is a **condition**, and each condition resolves one of five ways:

- **Already true** — a `file:` or `cmd:` source shows it. No node; record it as a claim.
- **Unknown** — a `recon` node finds out.
- **Needs a change** — a `build` node, plus the `verify` that proves it.
- **Needs a choice** — a `decide` node, or a `gate` when the choice is the user's.
- **Feeds only an outcome with the same owner and the same evidence** — it belongs to that node. Merge it in and union the paths.

Ask the same of every new node's conditions. Stop when each condition is already true, merged, or owned by a node.

Why backwards: forward decomposition ("first look at X, then change Y") produces a to-do list, with nodes that exist because they come next, not because anything needs them. Every node built backwards has a consumer. A node without a path to the terminal check is scope creep — cut it, or name it as a non-goal.

### An atomic node has four "one"s

- **One outcome** — stated as a result, not an activity.
- **One owner** — `self` or one agent type.
- **One write scope** — the paths that owner changes for that outcome; read-only nodes have none.
- **One kind of evidence** — a test, a live call, a rendered page, or a sourced claim.

Split a node when its success needs two kinds of evidence, when two owners would write it, or when part of it needs the user.

### Node kinds

| Kind | Does | Rule |
|------|------|------|
| `recon` | Answers a question the plan depends on — which tree the task belongs to, where X is called, whether it is really deployed | Read-only; adds sourced claims |
| `decide` | Makes a choice the sources answer | Cites the source; runs as `self` |
| `build` | Changes files in its write scope | Has a `verify` that depends directly on it; leaves its changes uncommitted, unless it works on an isolated branch |
| `verify` | Proves a build's success | Independent of the builder, as `checklists/evidence-gate.md` defines it |
| `gate` | Waits for authority, or for a choice that is the user's | `blocked` until the user's word; runs as `self`; other lanes keep moving |
| `reduce` | Merges parallel lanes and isolated worktrees into a local integration branch, resolves their conflicts, and lands the work on the target branch | Runs as `self`; lands only after reviews by two evaluator types and the full-suite `verify` |
| `write-back` | Records the outcome in ASM, the vault and memory | Runs as `self`, last — even while a gate is still `blocked`; exempt from the roll-up check |

### Every recall item must land somewhere

The recall pack is not decoration. Each item changes the graph:

- a **trap** → a success clause, a `verify` node, or a lock
- a **dead end** → a non-goal
- an **earlier decision** → removes a `decide` node
- a **status claim** ("not deployed", "the flag is X") → a `recon` node that checks live state before anything depends on it
- an **open thread the mission will finish** → goes to the `write-back`, which records it as finished — and closes it by its id, if your ASM version numbers threads

An item that changes nothing did not need recalling. Why this matters: records and hubs hold status snapshots that were never closed, and a graph built on one plans work that is already done — or skips work that never was.

### Where a decision waits

A decision the success signal depends on is asked during compilation, before any work starts. A decision that only one lane depends on becomes a `gate` inside that lane, so the other lanes keep moving.

### Independence means disjoint writes AND free resources

Two nodes may run at the same time only when no dependency path joins them, their write scopes are disjoint, and they hold no common **lock**. A lock names an exclusive resource on this machine:

- `test-runner` — one test run at a time on this machine
- `port:<n>` — a dev server or local service
- `tree:<path>` — a working tree another session also uses, or a shared local runtime such as `~/.asm`
- `host:<name>` — a production or staging machine
- `screen` — the user's display, mouse and keyboard
- `asm-refresh` — the brain rebuild

Disjoint files are not enough. Two lanes fixing unrelated bugs both end in a test run, so they serialize on `test-runner`.

### Waves and the critical path

Plan the waves at compile time by dependency depth, then move to the next wave any node that shares a path or a lock with another node in its wave. At run time the frontier is recomputed after every result — the waves are for the brief, the frontier is the truth.

A dependency is satisfied by `kept` or `skipped`. A node that cannot run without a skipped node's output is skipped too, with the reason.

The critical path — the longest dependency chain — sets the order when nodes compete for a lock: the node on it goes first. The primary agent keeps its attention there; lanes off it are the natural ones to hand to subagents.

### Size is a smell, not a limit

- 1-2 nodes — not a mission; do the work.
- 3-12 nodes — normal.
- More than about 12 — check whether you are graphing steps inside one lane. Many lanes of one shape are fine: seven isolated fixes are seven build–verify pairs. Implementation detail is not — collapse it into one `build` whose own plan is written when it runs.

A graph may grow mid-run when a lane finds something. That is orchestration working, as long as each new node enters the run file, with a `success`, before it runs.

## Examples

**Too fine.** "Add a field to the order form" graphed as recon → edit type → edit schema → edit UI → test → review. Type, schema and UI are three conditions, but each feeds the same outcome with the same owner and the same evidence: they merge into one `build` whose paths are the union, plus one `verify`.

**Hidden gate.** "Fix the support bot's greeting and push it live." The push is a `gate`. Folded into the build, autonomy either takes a production action or stalls halfway through a node — and the request alone is not the user's word.

**Hidden lock.** "Fix bug A in the server and bug B in the UI" looks like a clean fan-out — disjoint files. Both lanes end in a test run. Without `test-runner` on both, two runs start at once on one machine.

**Recall moved the node.** Making a voice agent sound more natural on calls looked like a prompt edit in the chat assistant's repo. Recall showed that repo does not own the live turn loop — the voice agent's turn loop lived in another repo — so the work moved there, and a two-copies trap in memory added a `recon` node: which of the voice agent's checkouts is the live one.

**Recall found a parallel session.** A dry run of "fix the session-end hook and add a cleanup command" found, through a live `git log`, that another session was building the hook fix on a new branch at that moment. That lane became one `verify` node on the live path instead of a second `build` in the same tree.

**Right-sized at scale.** A stability mission with seven isolated lanes: a baseline node; seven `build` lanes, each reviewed by a `verify` of a different agent type than its builder, two types across the lanes; a `reduce` that merged them into a local integration branch; an end-to-end `verify` that ran the full suite; and the deploy `gate` that lands the work — which stayed `blocked` on the user, exactly where it should stop. Lanes found four more nodes on the way; each entered the run file before it ran.

## Anti-Patterns

| Anti-Pattern | Why it hurts | Fix |
|---|---|---|
| Forward decomposition | Nodes nothing consumes; the graph mirrors the order of work, not the objective | Go goal-backward from the terminal check |
| Build without verify | "Done" is a self-report | Every `build` has a `verify` that depends directly on it |
| Lanes sharing a lock | Parallel test runs, port clashes, two sessions in one tree | Declare locks; one holder at a time |
| Gate folded into a build | A production action without the user, or a stall mid-node | Split out a `gate` |
| Asking what the sources answer | Spends the user's turn on a solved question | `decide` nodes cite the source |
| Decorative recall | Paid-for context that changed nothing | Each item changes a node, a criterion, a lock or a non-goal |
| Node per file | Ceremony, and fake parallelism over one write scope | One node per verifiable outcome |

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*

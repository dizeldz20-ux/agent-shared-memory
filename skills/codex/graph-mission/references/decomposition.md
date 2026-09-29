# Decomposition

How to cut the compiled objective into nodes. [graph-architecture.md](graph-architecture.md) picks the topology; this file decides what the nodes are. Most bad missions fail here: a node nothing consumes, a build nobody verifies, two lanes fighting over the test runner, a deploy hidden inside a build.

## Work backwards from the terminal check

Start at the check that proves the objective: a `verify`, or, for research and comparisons, the `recon` or `decide` whose sourced claims are the success signal. Ask what must be true for it to pass. Each answer is a condition, and each condition resolves one of five ways:

- **Already true**: a `file:` or `cmd:` source shows it. No node; record a claim.
- **Unknown**: a `recon` node finds out.
- **Needs a change**: a `build` node, plus the `verify` that proves it.
- **Needs a choice**: a `decide` node, or a `gate` when the choice is the user's.
- **Feeds only an outcome with the same owner and the same evidence**: it belongs to that node. Merge it in and union the paths.

Ask the same of every new node's conditions, and stop when each one is already true, merged, or owned by a node. Forward decomposition ("first look at X, then change Y") yields nodes that exist because they come next; every node built backwards has a consumer. A node with no path to the terminal check is scope creep: cut it, or name it a non-goal.

## An atomic node has four "one"s

One outcome, stated as a result rather than an activity; one owner, its `role`: `main` or one child; one write scope, none for a read-only node; one kind of evidence: a test, a live call, a rendered page, or a sourced claim. Split a node when its success needs two kinds of evidence, when two owners would write it, or when part of it needs the user.

## Node kinds

| Kind | Does | Rule |
|---|---|---|
| `recon` | Answers a question the plan depends on | Read-only; adds sourced claims |
| `decide` | Makes a choice the sources answer | Cites the source; runs as `main` |
| `build` | Changes files in its write scope | A `verify` depends directly on it; leaves its changes uncommitted unless it works on its own branch |
| `verify` | Proves a build's success | Independent of the builder, as [evidence-gate.md](evidence-gate.md) defines it |
| `gate` | Waits for authority, or for a choice that is the user's | `blocked` until the user's word; runs as `main`; other lanes keep moving |
| `reduce` | Merges lanes and worktrees into a local integration branch, resolves conflicts, lands the work | Runs as `main`; lands only under the landing rule in [compile.md](compile.md) |
| `write-back` | Records the outcome in ASM and the vault | Runs as `main`, last, even while a gate is still `blocked`; exempt from the roll-up check |

## Every recall item lands in the graph

- a trap: a success clause, a `verify` node, or a lock
- a dead end: a non-goal
- an earlier decision: removes a `decide` node
- a status claim ("not deployed", "the flag is X"): a `recon` node that checks live state before anything depends on it
- an open thread the mission will finish: its id goes to the `write-back`, which closes it

An item that changes nothing did not need recalling. Records hold status snapshots that were never closed, and a graph built on one plans work already done, or skips work that never was.

## Locks

Two nodes may run at once only when no dependency path joins them, their write scopes are disjoint, and they hold no common lock. A lock names an exclusive resource:

- `test-runner`: one test run at a time on the machine
- `port:<n>`: a dev server or local service
- `tree:<path>`: a working tree another session also uses, or a shared local runtime such as `~/.asm`
- `host:<name>`: a production or staging machine
- `screen`: the user's display, mouse and keyboard
- `asm-refresh`: the brain rebuild

Disjoint files are not enough: two unrelated fixes both end in a test run, so they serialize on `test-runner`.

## Waves, the frontier, the critical path

At compile time, plan waves by dependency depth, then push to the next wave any node that shares a path or a lock with another node in its wave. At run time the frontier ([run.md](run.md)) is recomputed after every result: the waves are for the brief, the frontier is the truth. `verified` and `skipped` satisfy a dependency; a node that cannot run without a skipped node's output is skipped too, with the reason.

The critical path, the longest dependency chain, decides who goes first when nodes compete for a lock. The primary keeps its attention there; lanes off it are the natural ones to hand to children.

## Size is a smell, not a limit

1-2 nodes: not a mission; do the work. 3-12: normal. More than about 12: check whether you are graphing steps inside one lane. Many lanes of one shape are fine (seven isolated fixes are seven build-verify pairs); implementation detail is not, so collapse it into one `build` that writes its own plan when it runs. The graph may grow mid-run when a lane finds something, as long as each new node enters the run file, with a `success`, before it runs.

## Anti-patterns

- **Build without verify**: "done" is a self-report.
- **Gate folded into a build**: "fix the greeting and push it live" is a build, a verify and a push `gate`. Folded together, the run either takes a production action without the word or stalls mid-node.
- **Hidden lock**: "fix bug A in the server and bug B in the UI" looks like a clean fan-out, but both lanes end in a test run.
- **Too fine**: "add a field" graphed as type, schema, UI and test nodes. Type, schema and UI share owner and evidence, so they are one `build` plus one `verify`.
- **Asking what the sources answer**: a `decide` cites the source instead of spending the user's turn.
- **A node per file**: ceremony, and fake parallelism over one write scope.

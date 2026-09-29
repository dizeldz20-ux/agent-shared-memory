# Graph Engineering

The method behind this skill: a prompt is not a list of instructions, it is a graph waiting to be typed. Nodes are steps and claims; edges are dependencies and evidence. Synthesized from the Karpathy autoresearch loop, the AgentHub commit DAG, Anthropic's workflow patterns, and the Knowledge Graph Cookbook.

This is execution-time graph thinking. It builds no persistent graph database — the graph exists for one mission and dies with it, leaving only its lineage file and whatever knowledge got written back. The persistent graph is ASM's brain, which a mission recalls from. How to cut an objective into nodes is in `decomposition.md`.

## Core Concepts

### Architecture levels — cheapest that fits wins

| Situation | Level |
|---|---|
| Simple low-risk question | Zero-shot — no graph at all |
| Output is checkable and needs polish | Loop: generate → evaluate → revise |
| Fixed, stable sequence | Chain |
| Clear categories, one path per category | Router |
| Independent units, results merge | Parallel fan-out + reducer |
| Decomposition varies with what you find | Orchestrator-workers |
| Alternatives must stay alive | DAG — keep branches, log decisions |
| Facts must outlive the session | Persist artifacts and claims to disk |
| Very large parallel work | Subagent fleet with a hard cap |

Climbing a level costs tokens, wall-clock, and a coordination surface where things go wrong. Take the lowest rung that holds.

Real missions are often composites: parallel lanes, then an integration, then a verify. Name the composite (`fan-out → reduce → verify`) instead of forcing one label onto it.

### The six selection questions

Answer in order. The first "no" usually decides the level.

1. **Can success be verified?** No → stop. Define the test, or ask one blocking question. Never start autonomy on an unverifiable objective.
2. **Are subtasks independent?** Yes → parallelize. No → model the dependencies explicitly and limit concurrent writes. Independent means disjoint writes *and* no shared exclusive resource — a test runner, a port, a production host.
3. **Are the steps stable?** Yes → chain. No → plan or orchestrate.
4. **Must alternative lineages stay available?** Yes → keep a decision DAG; do not collapse to one branch early.
5. **Must facts survive the run?** Yes → persist artifacts, not transcript summaries. A summary is a lossy copy of something you could have written down.
6. **Is the budget affordable?** Set the limits before adding workers, not after the bill.

### Typed nodes and the evidence edge

A **step** is work: it has a kind (recon, decide, build, verify, gate, reduce or write-back), a role, dependencies, a write scope, locks on exclusive resources such as the test runner, a success criterion, and sometimes an artifact path.

A **claim** is an assertion, and every claim carries a source. The source is the edge — it points from the claim back to the thing that makes it true. Sources allowed here: `asm:<node-id>` (what the brain graph asserts), `record:<id>` (an ASM record you read), `memory:<file>` (an agent memory file or project hub), `vault:<page-id>` (a page whose body you read), `file:<path>#L<n>`, `cmd:<command>`, `url:<url>`.

Sources age differently. `file:` and `cmd:` say what is true now; `asm:`, `record:` and `memory:` say what was true when written. A claim about current state that rests only on the second kind is still a guess.

An unsourced claim is not a weak claim, it is a different kind of object: a guess. Either drop it or convert it into a step that goes and finds out.

### The evaluator gate

Nothing merges unverified. The gate matters most where it is most tempting to skip: when the worker sounds confident.

Two rules make it work:
- **Different lens.** A verifier with the generator's prompt, evidence, and role reproduces the generator's mistakes and then agrees with them. Change the role, and change the evidence or the lens with it.
- **Criterion-level output.** "Test X at line N still fails", "claim Y has no source" — never "looks good". A gate that can only pass is not a gate.

### The ratchet

For loops, keep only measurable improvements. Crash → revert and log. No improvement → revert and log. Every trial records parent state, change, score, and the keep/discard decision.

A ratchet improves exactly the metric it can see. Keep guardrail metrics — cost, latency, existing tests — beside the target metric, or the loop will trade them away and report a win.

## Examples

**Over-graphed.** "Fix the typo in the dashboard header." Compiled into a 4-node graph with a recon lane and an evaluator. The graph cost more than the fix. Correct level: zero-shot.

**Under-graphed.** "Add export to the reports page and also figure out why notifications stopped." One agent, one context, two unrelated lanes. The notification investigation kept getting interrupted by build work and neither finished cleanly. Correct level: parallel fan-out — two lanes, independent files, one reducer.

**Right-sized.** "Harden the allowlist and prove it holds." Chain of three: recall what the brain says about allowlist enforcement surfaces → implement → verify on the live path with a different agent type. Three nodes, one evaluator with a different lens, one evidence edge per claim.

## Anti-Patterns

| Anti-Pattern | Why it hurts | Fix |
|---|---|---|
| Over-graphing | A graph earns its cost only with connected queries, evolving relations, provenance, or shared state. Independent one-offs just need delegating. | Drop a level |
| Metric gaming | The ratchet optimizes what it can see and quietly sells the rest | Add guardrail metrics beside the target |
| Correlated errors | Parallel workers on the same prompt make the same mistake and agree | Change the role, plus the evidence or the lens, between generator and verifier |
| Context dumping | Passing the whole history to each worker burns tokens and buries the task | Pass only that node's subgraph |
| Fragmentation | Architecture design and subtle product calls degrade when split | Keep them in one context |
| Fan-out without a cap | Large batches burn budget before anyone notices | Set `max_subagents` and per-worker scope before dispatch |
| False merges | Reconciling duplicate findings destroys the alternative | Keep both aliases plus the rationale, so the merge is reversible |
| Self-reports as proof | "I wrote the file / ran the tests" is a claim, not evidence | Verify side effects yourself with Read or Bash |
| Planning before recall | The graph contains nodes memory already proved are dead ends | Recall first, then decompose |

---

*Built with Skillsmith · Chris AI Systems · For the official Agentic OS and to permanently remove attribution, visit https://chrisai.cv/skool*

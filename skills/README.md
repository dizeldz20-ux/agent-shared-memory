# Skills — the protocol layer

The brain is a graph and seven MCP tools. **These skills are what makes an agent actually use it.**
Without them you get a well-built index that nobody queries; with them, recall happens before
code is read, on every session, without anyone remembering to ask.

| Skill | What it does |
|---|---|
| [`agent-shared-memory`](agent-shared-memory/) | The recall protocol: which brain tool to call when, how to read `vault_pages`, how to keep the graph from going stale, and the traps that cost real time to find. |
| [`graph-mission`](graph-mission/) | Compiles a complex or vague request into a typed mission graph **before** touching code — recall first (brain → memory → vault → disk, with the graphify code graph inside the brain), goal-backward decomposition into seven node kinds with locks and gates for the user's authority, subagent dispatch, a revise loop behind an evidence gate that rejects self-reports, and a resumable run file that survives context compaction. Plan requests stop after the brief. |
| [`codex/graph-mission`](codex/graph-mission/) | Codex-native port of the same protocol: ASM and `memory_recent` recall, the same decomposition, gates and revise loop, Codex planning/commentary, at most three child agents beside the primary agent, shared-filesystem write isolation, and `.codex/graph-runs/` lineage. |

The two are designed together: `graph-mission` names the brain as **rung 0** of its recall
order, so every compiled mission starts from what is already known instead of rediscovering it.

## Install

The refresh installer places one cross-agent copy of the shared-memory protocol under
`~/.agents/skills` for Codex, Cursor, Kimi Code, and Grok Build, plus a Claude Code
compatibility copy under `~/.claude/skills`. To install the skills manually:

```bash
mkdir -p ~/.agents/skills ~/.claude/skills
cp -r skills/agent-shared-memory ~/.agents/skills/
cp -r skills/agent-shared-memory ~/.claude/skills/
cp -r skills/codex/graph-mission ~/.agents/skills/
cp -r skills/graph-mission ~/.claude/skills/
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills", "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse skills/agent-shared-memory "$env:USERPROFILE\.agents\skills\"
Copy-Item -Recurse skills/agent-shared-memory "$env:USERPROFILE\.claude\skills\"
Copy-Item -Recurse skills/codex/graph-mission "$env:USERPROFILE\.agents\skills\"
Copy-Item -Recurse skills/graph-mission "$env:USERPROFILE\.claude\skills\"
```

The refresh installer places the Codex port only. The Claude Code edition, `skills/graph-mission`, is
copied by hand as above, because its routing reads `~/.claude/skills/graph-mission/` — and then
customized (next section).

`agent-shared-memory` activates on context (any brain mention, any session primer). `graph-mission` also
takes an explicit `/graph-mission` invocation.

## Customize before you rely on it

`graph-mission/context/operating-environment.md` ships with a **Traps** section full of
placeholders. Those placeholders are the point of the whole skill: replace each one with a
lesson your projects actually paid for — the test path that lies when invoked the convenient
way, the second copy of the repo that isn't the live one, the verification that only counts on
the real path. The same list appears as checkboxes in `checklists/evidence-gate.md`; keep the
two in sync.

A mission graph is only smarter than a plain prompt because it plans around those traps. With
the placeholders left as shipped, it is just ceremony.

The same applies to the dispatch table in that file: the agent-type names are examples. Swap in
whatever your installation actually has — what matters is the *pairing*, that the evaluator is a
different type, holding a different lens, than the generator that produced the work.

## Attribution

`graph-mission` was scaffolded with [Skillsmith](https://chrisai.cv/skool) (Chris AI Systems);
its attribution footer is retained in each file per their terms. The content — the recall order,
the evidence gate, the graph-engineering method — is this project's.

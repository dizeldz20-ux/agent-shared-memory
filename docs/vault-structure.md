# The vault — ASM's memory layer

ASM's knowledge layer is an **Obsidian vault**. The vault is not an attachment to the brain — it *is* the brain's memory: every page becomes a graph node, page `related` links become edges, and page tags/path references become the cross-layer edges that tie knowledge to code. Obsidian is required for the humans (editing, backlinks, graph view); ASM itself only reads two generated JSON files.

## Vault layout (openclaw-wiki structure)

```
YourVault/
├── wiki/main/               # the pages
│   ├── index.md
│   ├── entities/            # people/agents — name and role only
│   ├── concepts/            # reusable operating rules
│   ├── syntheses/           # cross-cutting summaries and maps
│   ├── sources/             # source/reference maps
│   ├── daily/               # dated notes (YYYY-MM-DD.md)
│   ├── architecture/        # code/product architecture pages
│   └── projects/<name>/     # per-project knowledge (README + docs/)
└── okf/                     # generated, machine-readable bundle
    ├── index.md             # progressive-disclosure index (entry point for agents)
    ├── catalog.json         # ← ASM reads this
    └── graph.json           # ← and this
```

## Page frontmatter

Every page carries frontmatter; the OKF fields are the ones that matter to ASM:

```yaml
---
id: unique-page-id            # becomes the brain node id: vault:<id>
pageType: entity | concept | synthesis | source | architecture | report
updatedAt: 2026-08-10T12:00:00+03:00
privacy: private | public
# --- OKF layer ---
description: "One sentence that lets an agent judge relevance without opening the page"
tags: [api, deploy, gotcha]   # tags matching a layer's xlayerTags → edge to that code layer
resource: /path/to/real/resource     # a path-like value → direct edge to that code file
related: [other-page-id, another-id] # page-to-page edges in the knowledge graph
contradictions: [superseded-id]      # when a page revises an older one — never overwrite silently
aliases: [סורק, Scanner]           # alternate/Hebrew names for recall only; never creates edges
---
```

The `description` field is the single highest-value line: it is what `brain_search` and the
prompt-recall hook match against, and what gets injected into an agent session as context.

## The okf/ bundle — the contract ASM consumes

ASM does not parse markdown. It reads two JSON files. The generator shipped in `tools/okf-build.mjs`
writes both: copy it into `<vault>/okf/` once, and every refresh runs it. Any other generator that
produces the same files works too (a ~30-line frontmatter scraper over `wiki/main/**` is enough):

**`okf/catalog.json`**

```json
{
  "concepts": [
    {
      "id": "api-deploy-gotchas",
      "path": "wiki/main/projects/api/docs/deploy.md",
      "title": "API deploy gotchas",
      "description": "One sentence for relevance triage",
      "tags": ["api", "deploy"],
      "pageType": "synthesis",
      "related": ["api-overview"],
      "resource": "src/server/deploy.py"
    }
  ]
}
```

**`okf/graph.json`**

```json
{ "edges": [ { "from": "api-deploy-gotchas", "to": "api-overview" } ] }
```

How ASM uses them (see `merge.py`):

- Every catalog concept → a `vault:<id>` node carrying `description`, `tags`, `pageType`.
- A tag that appears in a layer's `xlayerTags` (in `sources.json`) → `xlayer` edge from the page to that code layer's root.
- A path-like `resource`/`related` value → `xlayer` edge straight to the matching code **file** node (matched by its last two path segments).
- Every `graph.json` edge between two known pages → a `link` edge in the brain.

Regenerate the bundle whenever pages change (a Claude Code Stop hook that runs your
generator keeps it fresh automatically). Keep the writes atomic (tmp → rename) so a
half-written catalog never reaches a starting session.

## Rules that keep the memory trustworthy

- **One page per durable fact or topic.** The page is the source of truth; session memory should point at it, not duplicate it.
- **Never store secrets**: no API keys, tokens, passwords, raw private-message transcripts, or internal IPs. The vault feeds an index that other tooling reads — treat every page as shareable within the team.
- **Supersede, don't overwrite**: when a page revises an earlier claim, list the old page id under `contradictions` instead of silently editing history.
- **Stale is worse than missing**: a brain node pointing at a deleted file or a dead decision misleads with confidence. Refresh the bundle and the brain after structural changes.

# Evidence gate

Apply this before marking a node `verified`. The checks are proportional to the node, but provenance, observed side effects, and authorization are never optional.

## Provenance

- Every material claim has an ASM, memory, vault, current file, command, or authoritative URL source.
- Dated memory and vault facts were checked against current state when freshness matters.
- No claim rests only on a worker report or model confidence.

## Observed effects

- Claimed file changes were read back or inspected in a diff.
- Relevant tests or validation commands were observed by the primary agent, not inferred from “should pass.”
- The check used the project's sanctioned path from `AGENTS.md` and recalled traps.
- Runtime, UI, API, data, or infrastructure behavior was exercised at the appropriate layer when static inspection cannot prove it.

## Independent evaluation

- Non-trivial or high-risk output received a materially different lens, method, or evidence source.
- The evaluator reports criterion-level defects or a clean pass; “looks good” is not evidence.
- Independence is not claimed merely because two agents received the same prompt.

## Scope and safety

- Non-goals and exact write scopes held.
- Existing user changes were preserved.
- No success criterion was silently relaxed.
- No unrequested abstraction, dependency, production action, destructive operation, push, credential use, or external communication was introduced.

## External and temporal claims

- When a claim may have changed or high-stakes accuracy matters, browse and cite current primary or authoritative sources.
- Distinguish facts supported by a source from inferences drawn across sources.

## Decision

- Missing provenance, unobserved side effects, or missing authorization: `failed` or `blocked`; never verified with a caveat.
- Wrong verification path or insufficient independence: return to verification within budget; if exhausted, leave `pending` and report it.
- All relevant checks pass: attach the evidence and mark `verified`.

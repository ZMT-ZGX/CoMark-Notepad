# Domain Docs

Single-context repo.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the project's domain language and architecture overview.
- **`docs/adr/`** — architectural decision records. This directory does not exist yet; `/domain-modeling` (reached via `/grill-with-docs` and `/improve-codebase-architecture`) will create ADRs lazily when terms or decisions actually get resolved.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 — but worth reopening because…_

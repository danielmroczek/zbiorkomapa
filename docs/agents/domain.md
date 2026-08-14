# Domain docs — Single-context

This repo uses a **single-context** layout for domain documentation.

## Layout

- `CONTEXT.md` — domain glossary / ubiquitous language (already exists at repo root)
- `docs/adr/` — Architecture Decision Records (one markdown file per decision, numbered)

## Consumer rules

1. **Read `CONTEXT.md` first** when onboarding or before making changes that touch domain concepts. It defines the shared vocabulary (City, Route, Direction, Stop, Shape, Ride, Trail, etc.).
2. **Check `docs/adr/`** for architectural decisions that constrain implementation choices. Each ADR records a decision, its context, and its consequences.
3. **Update `CONTEXT.md`** when adding or renaming domain concepts. Keep it a glossary — no implementation details.
4. **Add an ADR** when making a significant architectural choice that future contributors need to understand. Follow the standard ADR format (Title, Status, Context, Decision, Consequences).

## No multi-context

This is not a monorepo. There is one domain context shared across the entire codebase. If the repo grows into a multi-package structure, revisit this and consider a `CONTEXT-MAP.md` pointing to per-package `CONTEXT.md` files.

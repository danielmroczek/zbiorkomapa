# Issue tracker — Local markdown

Issues live as markdown files under `.scratch/<feature>/` in this repo.

## Convention

- Each feature or work stream gets its own directory: `.scratch/<feature>/`
- Individual issues are markdown files inside that directory: `.scratch/<feature>/<issue-slug>.md`
- Issue files use a minimal front-matter format (title, status, labels) followed by the body.
- Status values: `open`, `in-progress`, `closed`.
- Labels are freeform strings; use them to categorize (e.g. `bug`, `feature`, `chore`).

## Example

```
.scratch/
  audio-matcher/
    fix-null-audio-id.md
    add-fuzzy-matching.md
  shape-rendering/
    deduplicate-coords.md
```

## When to use

- Solo projects or repos without a remote issue tracker.
- Skills like `to-tickets` and `to-spec` write issue files here.
- The `triage` skill (if installed) reads from and writes to this directory.

## PRs as a request surface

Not applicable — this repo uses local markdown, not a hosted tracker.

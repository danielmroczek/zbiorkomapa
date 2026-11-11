---
title: Gorzów has three lines with non-numeric short_names and dozens of Punkty końcowe
status: open
labels: bug, data
---

## Symptom

Three of the 47 Gorzów Wielkopolski routes have a `short_name` that is not a line
number, and a Punkt końcowy (endpoint) count far above every other route in every city:

| route_id | short_name | directions | unique Punkty końcowe | total stops |
|----------|-----------|------------|-----------------------|-------------|
| 2154 | `Tech` | 46 | 21 | 94 |
| 1374 | `Doj`  | 17 | 16 | 34 |
| 478  | `Zj`   | 14 | 14 | 29 |

Every other Gorzów route has at most 6 unique Punkty końcowe; Poznań tops out at 6.

## Why it looks like a bug

`scripts/route-assembler.js` merges GTFS `route_id`s that share a `route_short_name`
into one logical line (documented in `AGENTS.md` as the Gorzów pattern). Under that
rule, a group of unrelated `route_id`s that all carry the same junk `route_short_name`
would be merged into one giant pseudo-line — which matches the 46-direction shape of
`2154`.

## What to check

1. Inspect `routes.txt` in `data/gorzow-wielkopolski/`: are `Tech` / `Doj` / `Zj` real
   `route_short_name` values, or are they truncated / placeholder text?
2. Confirm the merge in `groupRoutesByShortName` is grouping genuinely unrelated
   `route_id`s.
3. Decide whether these are real lines that deserve a proper name, or feed noise that
   the processor should skip.

## Not blocking

The line picker truncates the endpoint list (`endpoints` in `routes.json`, rendered as
`+N`), so these three lines render fine — they just show `+18` and similar. This is a
data-quality issue, not a UI one.

## Discovered while

Implementing Punkty końcowe in the line picker — see `CONTEXT.md` →
"Punkt końcowy (Terminus)".

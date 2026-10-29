Every link you save is a promise to your future self. Most of those promises break quietly, because the page behind them changes, moves, or disappears without warning.

## Store content at ingest time

The first rule is simple: archive the content when you ingest the link, not when you read it. By the time you come back, the live page may already be gone.

*   Fetch once, store markdown alongside the URL.
*   Record which extractor produced the content.
*   Flag pages that need a real browser session.

Storing the extracted markdown also means your triage views never depend on a page staying reachable. The link becomes a reference, not a dependency.

## Extraction is a solved problem, mostly

Static pages extract cleanly with a DOM-based readability pass. The hard cases are the ones that need JavaScript, and the honest answer for those is to run a browser, not to write a better parser.

> Extraction quality is a routing decision, not a parsing problem.

Measure yield per extractor. If a page comes back nearly empty, escalate to a different extractor rather than shipping empty content into your inbox.

## Expiry is a decision you can make later

Nothing needs to be deleted automatically. A sweep proposes what is stale; you approve it. Archiving is cheap, deleting is not.

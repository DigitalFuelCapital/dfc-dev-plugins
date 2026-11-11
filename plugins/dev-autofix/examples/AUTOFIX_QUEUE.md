# Autofix queue

Pre-verified fix plans consumed by `/dev-autofix:run`. Written by `/dev-autofix:plan`.

Each entry is one PR. A worker takes the first `status: ready` entry for its repo whose
`after:` is `none` or names an entry already `merged` into the base branch, executes the
plan as written, and the lead updates `status:` afterwards. `needs-human` entries wait for
the decision written in their status line; change them to `ready` once you have decided.

The helpers rely on this layout: one `## Summary - <repo>` table per repo, then
`## Inbox`, `## Entries` and `## Dropped`. Keep those headings as they are.

## Summary - my-api

| slug | status | after | title |
|---|---|---|---|
| drop-unused-cors-helper | ready | none | Remove the unreferenced withCors wrapper |
| tighten-token-compare | needs-human | none | Compare access tokens in constant time |

## Inbox

One-liners noticed by fix workers, for the next `/dev-autofix:plan` to investigate:

- `src/routes/health.ts` swallows errors in a bare catch, returns 200 regardless

## Entries

### drop-unused-cors-helper · my-api · Remove the unreferenced withCors wrapper
- status: ready
- kind: mechanical
- risk: low · size: ~30 changed lines · deps-change: no
- after: none
- files: src/middleware/cors.ts:12-48, src/index.ts:9
- problem: `withCors` is exported from `src/middleware/cors.ts:12` and imported once at
  `src/index.ts:9`, but the import is unused - the router applies `honoCors()` directly at
  `src/index.ts:44`. Verified against origin/staging @ a1b2c3d on 2026-09-23:
  `grep -rn 'withCors' src` returns only the definition and the dead import.
- plan:
  1. Delete the `withCors` export and its helper types from `src/middleware/cors.ts`.
  2. Remove the unused import at `src/index.ts:9`.
  3. Leave `honoCors()` at `src/index.ts:44` untouched - that is the live path.
- verify: `npm run lint && npm run typecheck && npm run test` green; `grep -rn withCors src`
  returns nothing.
- pr: Remove the unreferenced withCors wrapper | withCors has no callers; the router uses
  honoCors directly.
- watch-outs: Do not touch `honoCors` or the allowed-origins list. The two names are one
  character apart in the import block.

### tighten-token-compare · my-api · Compare access tokens in constant time
- status: needs-human (is a timing-safe compare worth the added dependency on node:crypto here, or should this move behind the gateway instead?)
- kind: security
- risk: medium · size: ~15 changed lines · deps-change: no
- after: none
- files: src/auth/token.ts:22
- problem: `src/auth/token.ts:22` compares the bearer token with `===`, which short-circuits
  on the first differing byte. Verified against origin/staging @ a1b2c3d on 2026-09-23.
- plan: (awaiting the decision above)
- verify: `npm run lint && npm run typecheck && npm run test`; add a unit test asserting the
  comparison rejects a token differing only in its final byte.
- pr: Compare access tokens in constant time | `===` short-circuits, leaking token bytes
  through response timing.
- watch-outs: `kind: security` entries are never auto-executed, even once `ready`. Fix this
  one by hand after deciding.

## Dropped

- `rewrite-order-pipeline` - ~900 changed lines across 14 files. Too large for one PR and
  not splittable without a design decision.
- `bump-drizzle` - dependency change; out of scope for autofix.

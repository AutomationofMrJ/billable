# Billable v1 contract and file ownership

Shared types in `shared/types.ts` are the source of truth. All money is safe integer minor units; decimal user inputs are strings. Only the server calculates money, balances, contributions, tax and rounded invoice lines. UI formats values only.

The browser and API share one origin at http://127.0.0.1:4318. `GET /api/session` returns `{token}`. `GET /api/state` returns AppState. `POST /api/command` accepts CommandEnvelope, requires `X-Billable-Token`, and returns CommandResult. Use a UUID requestId for each intended operation; retain it on retries. The workspaceId guards against two tabs changing workspaces silently. Errors use ApiError with 400 validation, 409 conflicts, 404 absent record, 413 size, 422 unsupported issuance.

`GET /api/backup` downloads a ZIP snapshot of the active workspace; `backup.restore` validates it and switches to a new workspace, preserving the original. `GET /api/attachments/:id` returns safe attachment bytes. `GET /api/export` downloads a JSON analysis export. No direct SQL in the browser or agents. No cloud writes.

Draft creation reserves approved billable time. A time entry has one draft or issued invoice at most. Draft deletion releases reservations. Fixed price projects create one contract line and never add an hourly charge; time remains available for measuring effort. Issue performs numbering, immutable document snapshot and allocation atomically. Payments affect balance only. Credits reduce revenue and balance. Payment reversal creates a negative linked receipt, never edits history.

Issuance scope: Netherlands supplier with EUR books, VAT registered and not on the small business scheme, with required details. Customer country decides the VAT path: NL 21%/9% lines, EU reverse charge (0%, customer VAT ID) or outside the EU (0%). Invoices may use any ISO currency with `exchangeRate` (1 base = rate document units); `base*Minor` fields carry the base-currency equivalents used for revenue, totals and VAT. Expenses may have `projectId: null` (general costs) and a `vatTreatment`; `expense.update` edits them. `vat.filing` records a filing status per VAT period. AppState adds `vatPeriods`, `months` and `years`, all computed by the server. All other paths keep usable drafts. Client/supplier details, rates, tax and logo ID are frozen on issue. Business currency cannot change after any records exist. Missing cost confirmation gives unknown contribution, not zero cost. Work and revenue are lifetime totals per project in v1; active fixed projects are visibly provisional.

Ownership during this build:
- Root Codex: shared/*, server/store.ts, server/schema.ts, server/index.ts, server/validation.ts, package/config integration.
- UI Codex helper: src/* only, using the shared contract. This supplies a working baseline before Claude is available.
- Reliability helper: server/backup.ts, tests/backup.test.ts, scripts/*, backup documentation. No active database edits; only generated temporary fixtures in tests.
- Finance helper: shared/money.ts, tests/money.test.ts, tests/store.test.ts after store exists; documentation and handoff.

Claude later owns src/* and print styling. Claude must coordinate before changing shared contracts and introduce no second backend or calculation layer. The hosted browser demo (`demo/`) reuses server/store.ts unchanged on SQLite WebAssembly; it is not a second calculation layer.

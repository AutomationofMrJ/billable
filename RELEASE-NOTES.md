# Billable 0.1.0 — release notes

First community release, prepared for the AI Grandmaster competition (deadline 4 October 2026, 16:00 Amsterdam). Billable is a working name; see NAMING.md.

## What it does

A local work ledger for freelancers and small studios. It answers one question: **which work actually earns something, once preparation, meetings and aftercare are counted?**

- **Time**: manual entries or a timer whose start time survives a restart. Categories for delivery, preparation, meetings, aftercare and other work. Billable or not, approved or still a proposal. Future work can only be a proposal. Long or overnight timer sessions are not pre-approved.
- **Projects**: hourly or fixed price per client, with a per-project record view. It shows contribution per actual hour, where the hours went by category, how much unbilled work came with each billable hour, and the time, costs and invoices behind each figure.
- **Invoices**: drafts from approved, unallocated hourly time (time is reserved, so it can't be invoiced twice), or one contract line for a fixed price. Final issuing gives an atomic number and a frozen snapshot of supplier, client, prices and logo. Part payments, payment reversals and numbered credit notes, with "refund due" shown honestly. Printing (browser Save as PDF) uses a multi-page layout that repeats table headers. Drafts carry a DRAFT marker on every page.
- **Expenses**: direct project costs with deductible or non-deductible tax and optional original PNG/JPEG/PDF attachments.
- **Overview**: revenue, ready to invoice, outstanding and actual hours, plus a project comparison per actual hour. Contribution stays "Unknown — confirm direct costs" until costs are confirmed; it is never shown as zero.
- **Backup**: one ZIP with SQLite snapshot, JSON, CSV, attachments and hash manifest. Restore validates first and opens a new workspace; the original stays available.
- **Workspaces**: a fictional demo, kept clearly separate from your own empty workspace.

## Added from Jeroen's own bookkeeping workbook

- All ISO countries and currencies in settings, clients, expenses and new workspaces.
- Invoices in any currency with an exchange rate; VAT also shown in the base currency.
- Issuance for Dutch customers at 21% or 9%, EU business customers with reverse charge, and customers outside the EU.
- Expenses without a project (general costs), editable, with supplier, invoice number, category, country, payment method, original currency/amount and VAT treatment including reverse charge.
- Reports: VAT return per period in the Netherlands box layout with filing status, year overview with monthly and cumulative result, hours per project per month.
- Time start/end, notes and custom categories; project statuses quote/paused/cancelled and notes; client contact person, registration and notes; VAT filing frequency and small business scheme setting.
- Workspace schema v2 (general costs). Existing workspaces upgrade on open; v1 backups still restore.

## Scope and honesty

- Final invoices only for a VAT registered **Netherlands supplier with EUR books**: Dutch customers at 21%/9%, EU reverse charge, customers outside the EU. Everything else stays a usable draft that lists why it can't be issued.
- Contribution is before general overhead and income tax. The VAT overview prepares figures; it does not file. No tax filing, bank sync, e-invoicing, email sending, cloud sync or phone access.
- Tested on **Windows x64, Node.js 24.14.1, npm 11.11.0**. Other systems have not been release-tested.
- Core features need no AI key, account or subscription. Nothing is sent anywhere; the server listens on 127.0.0.1 only.

## Verification

Checks performed for this release: `npm test`, `npm run build`, a clean install from the release ZIP with `npm ci --ignore-scripts` on Windows x64, and a scripted end-to-end UI flow. Other operating systems have not been release-tested.

## Credits

Built by Jeroen with Codex (data model, server, finance core, backup/restore, tests) and Claude (interface, print layout, UI verification). Dependency and font licenses: THIRD-PARTY-NOTICES.md. Source license: MIT.

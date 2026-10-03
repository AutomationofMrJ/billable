# Billable — know what your work is worth

A small local work ledger for independent professionals. Connect paid and unpaid work, invoice drafts, direct project costs and receipts. Compare contribution per **all confirmed work hours**, including preparation, meetings and aftercare. No AI key, hosted database or subscription is needed for the core app.

## Install and start

Initial supported/test platform: Windows x64, Node.js **24.14.1** (24 LTS), npm **11.11.0**. Install Node 24 LTS first. This is a source/project download, not a standalone executable. Internet is needed to install dependencies; normal use is local after installation.

Extract the release to a normal local folder, open PowerShell there, and run:

```powershell
npm ci --ignore-scripts
npm run build
npm start
```

Or double-click `Start-Billable.cmd`, which runs the same steps when needed. `--ignore-scripts` matters: the SQLite package ships ready-made binaries, and without the flag npm tries to compile it, which fails unless Visual Studio C++ build tools are installed. The included `.npmrc` sets the same option.

Open **http://127.0.0.1:4318** in a browser. Keep the terminal running. Stop with Ctrl+C; run `npm start` to resume. One server owns a data folder at a time. The first launch opens a **fictional demo workspace**. Use the workspace menu to create a new, empty workspace for your own records. Never repurpose the demo as your real administration.

The dependency versions are pinned in package.json/package-lock.json. better-sqlite3 includes prebuilt native binaries for Windows, macOS and Linux; a clean install from the release ZIP with `npm ci --ignore-scripts` was verified on Windows x64 without build tools. Other operating systems have not been release-tested.

## Where your data lives

On Windows, the default is `%LOCALAPPDATA%\Billable\workspaces\`, separate from the source and release folders. Each workspace has its own SQLite file containing records and attachment bytes. Removing/replacing the application source does not migrate or delete that data folder. No data is written to OneDrive, Google Drive or any external server automatically.

For an explicit local data location, set it before starting:

```powershell
$env:BILLABLE_DATA_DIR = 'D:\MyLocalRecords\Billable'
npm start
```

Keep the **active** folder outside cloud sync directories. Save closed ZIP backups to OneDrive/Drive if you want another copy. Database and backups are not encrypted by this application; rely on your account/device protection and keep exports private. The app binds only 127.0.0.1 and is not remotely available from your phone.

## Your first complete flow

1. Create an empty workspace and fill in Settings (business, currency, invoice numbering, tax and optional PNG/JPEG logo).
2. Add a client and an hourly or fixed project. Confirm whether direct project costs are complete; leave unchecked while costs are unknown.
3. Record time or start a timer. Review and confirm the human duration when stopping; browser/agent elapsed time is not automatically approved work. Mark billable status and approval. Edit unassigned time when needed.
4. Create a draft from approved, unassigned billable time. A fixed project has one contract line; its tracked hours never add a second hourly charge. Drafts reserve selected time; delete a draft to release its reservation, then recreate to correct lines/dates.
5. Inspect the print layout. Print / Save as PDF through the browser. Printing does not mark a document as sent or paid. Drafts remain visibly labelled drafts.
6. The restricted NL standard path can issue an immutable snapshot with an atomic unique number and time allocation. Other tax/country situations stay drafts. Issue only after checking applicability to your own transaction.
7. Record actual payments, including part payments. A mistaken payment is reversed with a linked negative record. Corrections use a separately numbered credit note; they do not overwrite an issued invoice. A paid invoice followed by a credit can show a **refund due**, not invented extra revenue.
8. Add direct costs and original PDF/PNG/JPEG receipts (5 MB each; total 50 MB per workspace). Confirm cost completeness and compare projects in Overview.
9. Download a full backup, then restore into a new workspace and verify records and receipts. Keep an off-device copy. See BACKUP.md.

## Financial scope

All booked amounts are integer cents/pence. Decimal quantities and percentages use one deterministic Decimal core; tax rounds half up per line. Time uses integer minutes. A saved time entry keeps its hourly rate; changing the project rate affects newly recorded time. Issued invoices freeze supplier, customer, rates, taxes and logo references. Workspace currency cannot relabel existing financial records.

Revenue = issued net invoices minus net credits. Payments reduce outstanding receivables, not revenue. Direct cost = net expense plus non-deductible tax. Contribution = revenue minus direct costs, **before general overhead and personal/business income tax**. Contribution is unknown until costs are confirmed complete; zero hours gives unknown contribution/hour. Project totals are lifetime totals. Active project results are provisional. Contracted fixed fees and unbilled hourly work are shown separately from actual issued revenue. Future documents remain drafts.

### Supported issue path

Final invoices are enabled for a VAT registered **Netherlands supplier keeping its books in EUR** (not on the small business scheme), with required supplier/customer details: Dutch customers at **21% or 9%**, **EU business customers with reverse charge** (0%, customer VAT ID required, printed as “VAT reverse-charged”) and **customers outside the EU** (0%, printed as “No Netherlands VAT”). The customer country decides the path. Source: [Belastingdienst invoice fields](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/administratie_bijhouden/facturen_maken/factuureisen/), checked 3 October 2026. The app checks presence/format; it cannot verify legal identity or whether the treatment actually applies. Domestic 0%/exempt lines, KOR invoices and structured e-invoice workflows remain drafts. No tax return filing, universal compliance, income-tax calculation, certified archive or electronic delivery is claimed.

### Currencies, VAT overview and reports

- **Every ISO country and currency** is selectable for your business, clients, suppliers and workspaces. All amounts are stored with two decimals.
- **Invoices in another currency**: choose the currency and the rate (1 base unit = x document units). Unit prices convert once; lines, payments and credits stay in the document currency, while revenue, outstanding totals and VAT use the base-currency equivalent. VAT is also printed in the base currency.
- **Expenses**: project costs or general business costs, with supplier, supplier invoice number, category, supplier country, payment method, notes, the original currency and amount, and a VAT treatment (supplier VAT, no VAT, domestic reverse charge, import from outside the EU, intra-EU). Reverse-charged VAT is self-assessed at the default rate and deductible unless you untick it.
- **Reports**: a VAT return per quarter, month or year in the Netherlands box layout (1a–1e, 2a, 3b, 4a, 4b, 5a, 5b and balance) with a filing status per period; a year overview of revenue, costs, result and cumulative result per month; hours per project per month.
- **Time** can carry start/end times, notes and any category; projects can be quote, in progress, paused, completed or cancelled; clients can have an attention-of contact, registration number and notes.

These figures help you prepare; check them before filing. Exchange-rate gains or losses are not booked.

## Backups, exports and agents

Use **Backup** for full restoration: SQLite snapshot, JSON, time CSV, original attachments and hash manifest in one ZIP. Restore validates before creating a new workspace and preserves the old workspace. Invalid archives cannot replace your active records. A restored timer is stopped so old elapsed time cannot be mistaken for work.

Use the analysis JSON export for inspection/import into other tools; it is not a restore archive and has no receipt bytes. No financial data is sent to an AI provider. If you choose to share an export, review its contents and destination. Agents must use validated local commands; do not edit the live SQLite database or use backup files as a shared live datastore.

## Development and verification

```powershell
npm run dev
npm test
npm run build
npm run release
```

`npm run dev` serves UI and API from the same loopback origin. Source boundaries and API are in API-CONTRACT.md; what's included is in RELEASE-NOTES.md.

### Hosted browser demo

`npm run build:demo` builds `dist-demo/`, a static version of the app for the online demo (Vercel, see `vercel.json`). It runs the same `server/store.ts` inside the browser on SQLite compiled to WebAssembly (sql.js); `demo/shims/` maps the few Node APIs it uses. Demo data stays in that browser (IndexedDB). Backup/restore are local-app only. `npm run dev:demo` serves it locally.

## Limits and license

One business/user/base currency per workspace; manual exchange rates; manual payments; one fixed-price invoice per project; full time allocation only; credits use the original uniform tax rate. Long invoices use browser multipage print; rendering can vary by browser. There is no send button/email, bank sync, cloud sync, live phone access, tax filing, AI activity capture, calendar import or e-invoice standard. The original Excel workbook has not been touched.

MIT source license; dependency and font notices in THIRD-PARTY-NOTICES.md. Billable is a temporary name. NAMING.md records a similar existing product and naming alternatives; no legal trademark availability is claimed.

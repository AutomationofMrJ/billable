# Full local backup and restore

Use **Settings → Download full backup** to download one closed ZIP archive for the active workspace. A successful download contains one consistent SQLite snapshot, the original expense attachments and every retained invoice logo. Back up demo and real workspaces separately; the manifest labels each workspace.

Keep several dated copies. A closed backup archive can be copied to OneDrive, Google Drive or another backup location. Do not place the active SQLite database in a synchronised folder. Stop the app before manually moving its data directory. Browser JSON/CSV analysis exports do not replace a full backup.

To restore, choose the ZIP in Settings. Validation completes before the server creates and activates a new workspace. The restored workspace receives a new identity; the original administration remains available. The server clears any running timer on restore so an old start time does not become fictitious new work. Documents, their numbers, payment and credit history, amounts, attachment IDs and file bytes remain unchanged. Demo metadata remains explicit.

The v1 backup is unencrypted. It contains addresses, business details, invoices and receipts. Store it where you would store your financial documents. SHA-256 hashes detect corruption and discrepancies between entries; they do not prove who created a backup. An attacker can recompute hashes. Import therefore also verifies the exact supported database schema and financial/reference invariants. Treat the archive as financial data when sharing it.

## Portable format, version 1

| Entry | Contents |
| --- | --- |
| `manifest.json` | Format/version, schema version, creation timestamp, original workspace metadata, per-table counts and SHA-256/size of every payload entry. The manifest does not hash itself. |
| `database.sqlite` | Complete SQLite online-backup snapshot, including immutable invoice snapshots, history, settings, attachments and ancillary idempotency cache. |
| `records.json` | Canonical deterministic JSON containing all business tables; attachment metadata excludes binary bytes. Ancillary request cache is omitted. Monetary numbers are integer minor units. |
| `time.csv` | Quoted UTF-8 time export with project labels, integer minutes, approval/billability, captured hourly rate in minor units and actual invoice assignments. |
| `attachments/<UUID>` | Original attachment bytes; original filename, MIME, size and hash are stored in the database/JSON metadata. No user filenames become archive paths. |

The JSON export uses `{ "version": 1, "schemaVersion": 1, "tables": { ... } }`. Table rows retain their stored SQL columns; each `data` column contains the original JSON document string. Keys and rows are sorted. Money uses two decimal places for supported currencies; `rateMinor: 15000` means EUR 150.00 in a EUR workspace. Decimals such as line quantities and tax rates remain strings. JSON/CSV are inspectable exports, not editable restore formats.

CSV fields are always quoted; embedded quotes double and embedded line breaks remain inside the quoted field. Labels beginning with spreadsheet formula characters receive an apostrophe in the CSV only. This prevents exported descriptions from being executed as formulas when opened in spreadsheet tools.

## Validation and limits

SQLite's online backup API creates a snapshot in an OS temporary directory. Export reads that snapshot read-only, builds the archive and validates it again before returning a successful download. A write that occurs after the snapshot is included in the next backup.

Restore rejects unsupported versions, foreign schema objects (including extra triggers or views), failed SQLite integrity/foreign-key checks, inconsistent row counts, inconsistent SQL/JSON/CSV data, invalid money or allocations, missing original attachments, altered hashes and MIME/signature mismatches. Imported SQL is never migrated before validation. Duplicate/unknown/traversal paths, encrypted ZIP entries and unsupported compression methods are rejected. Import does not extract arbitrary paths.

- Maximum compressed archive: 128 MiB.
- Maximum total expanded entries: 128 MiB.
- Maximum ZIP entries: 1,200.
- Original attachment: up to 5 MiB, PNG/JPEG/PDF only.
- Total stored attachment bytes: 50 MiB per workspace.

Temporary snapshot files are removed after success or failure. If the backup exceeds these limits, reduce retained attachments or move completed work to another workspace; the app does not silently exclude receipts. Requests in the snapshot are an implementation cache, not invoice evidence, and may be reset by restore.

## Recovery check

Before relying on a new installation, create a backup and restore it as a new workspace. Compare invoice totals and open balances, client/project/time counts, and open a restored receipt and logo. The automated backup tests use generated fictional temporary workspaces and check complete round trips, persistence, corrupt imports, unsafe ZIP entries, schema tampering and original attachment preservation.

Backups include the active workspace only. Repeat the export for any other workspace you want to preserve. There is no automatic cloud backup, live sync, password encryption or external authenticity signature in this release.

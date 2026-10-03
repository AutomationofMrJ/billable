import type Database from 'better-sqlite3';
export const SCHEMA_VERSION = 2;
/** Oldest backup schema that can be validated as-is and then upgraded by migrate(). */
export const OLDEST_SUPPORTED_SCHEMA = 1;
export const JSON_TABLES = ['settings','clients','projects','time_entries','invoices','draft_times','allocations','payments','credits','expenses','audit_events'] as const;
export const BACKUP_TABLES = [...JSON_TABLES, 'attachments'] as const;
export function migrate(db: Database.Database, target = SCHEMA_VERSION) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  let version = db.pragma('user_version', { simple: true }) as number;
  if (version > SCHEMA_VERSION) throw new Error('This workspace needs a newer Billable version.');
  if (version === 0 && target >= 1) db.transaction(() => {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE clients (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE projects (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE time_entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE invoices (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), client_id TEXT NOT NULL REFERENCES clients(id), status TEXT NOT NULL CHECK(status IN ('draft','issued')), number TEXT UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)), CHECK((status='draft' AND number IS NULL) OR (status='issued' AND number IS NOT NULL)));
      CREATE TABLE draft_times (time_id TEXT PRIMARY KEY REFERENCES time_entries(id), invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE);
      CREATE TABLE allocations (time_id TEXT PRIMARY KEY REFERENCES time_entries(id), invoice_id TEXT NOT NULL REFERENCES invoices(id));
      CREATE TABLE payments (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), reversal_of TEXT UNIQUE REFERENCES payments(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE credits (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), number TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE attachments (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880), sha256 TEXT NOT NULL, bytes BLOB NOT NULL, CHECK(length(bytes)=size));
      CREATE TABLE expenses (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), attachment_id TEXT REFERENCES attachments(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE audit_events (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)));
      CREATE TRIGGER frozen_invoice_update BEFORE UPDATE ON invoices WHEN OLD.status='issued' BEGIN SELECT RAISE(ABORT, 'Issued invoices are immutable'); END;
      CREATE TRIGGER frozen_invoice_delete BEFORE DELETE ON invoices WHEN OLD.status='issued' BEGIN SELECT RAISE(ABORT, 'Issued invoices are immutable'); END;
      CREATE TRIGGER frozen_payment_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'Payments are immutable'); END;
      CREATE TRIGGER frozen_credit_update BEFORE UPDATE ON credits BEGIN SELECT RAISE(ABORT, 'Credit notes are immutable'); END;
      PRAGMA user_version = 1;
    `);
  })();
  version = db.pragma('user_version', { simple: true }) as number;
  // v2: general business expenses need no project, so project_id becomes nullable.
  if (version === 1 && target >= 2) db.transaction(() => {
    db.exec(`
      CREATE TABLE expenses_v2 (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), attachment_id TEXT REFERENCES attachments(id), data TEXT NOT NULL CHECK(json_valid(data)));
      INSERT INTO expenses_v2 (id, project_id, attachment_id, data) SELECT id, project_id, attachment_id, data FROM expenses;
      DROP TABLE expenses;
      ALTER TABLE expenses_v2 RENAME TO expenses;
      PRAGMA user_version = 2;
    `);
  })();
}

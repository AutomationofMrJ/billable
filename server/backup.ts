import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Workspace } from '../shared/types.js';
import { lineAmount, MAX_MONEY, sumMoney, tax, timeAmount, toBase, toDocument } from '../shared/money.js';
import { isCurrency } from '../shared/geo.js';
import { BACKUP_TABLES, migrate, OLDEST_SUPPORTED_SCHEMA, SCHEMA_VERSION } from './schema.js';

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_ATTACHMENTS = 50 * 1024 * 1024;
const MAX_ENTRIES = 1200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVERSE_CHARGE = ['reverse-domestic', 'import-non-eu', 'intra-eu'];
type Row = Record<string, unknown>;
type Tables = Record<typeof BACKUP_TABLES[number], Row[]>;
interface Manifest {
  format: 'billable-backup'; version: 1; schemaVersion: number; createdAt: string;
  workspace: Workspace; counts: Record<string, number>;
  files: Record<string, { size: number; sha256: string }>;
}

function fail(message: string): never { throw new Error(`Invalid backup: ${message}`); }
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function object(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Row;
}
function parseJson(text: unknown, label: string): unknown {
  if (typeof text !== 'string') fail(`${label} must contain JSON.`);
  try { return JSON.parse(text); } catch { return fail(`${label} contains invalid JSON.`); }
}
function json(text: unknown, label: string): Row { return object(parseJson(text, label), label); }
/** Stable exports can be independently compared with the database snapshot. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const item = value as Row;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function workspaceFrom(db: Database.Database): Workspace {
  const row = db.prepare("SELECT data FROM settings WHERE key='workspace'").get() as Row | undefined;
  const data = json(row?.data, 'Workspace');
  if (typeof data.id !== 'string' || !UUID.test(data.id) || typeof data.name !== 'string' ||
      data.name.length < 1 || data.name.length > 200 || typeof data.demo !== 'boolean' ||
      typeof data.currency !== 'string' || !isCurrency(data.currency)) fail('Workspace metadata is unsupported.');
  return data as unknown as Workspace;
}
function rowsFrom(db: Database.Database): Tables {
  return Object.fromEntries(BACKUP_TABLES.map(table => {
    const columns = table === 'attachments' ? 'id, name, mime, size, sha256' : '*';
    return [table, db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${table === 'settings' ? 'key' : table === 'draft_times' || table === 'allocations' ? 'time_id' : 'id'}`).all()];
  })) as Tables;
}
function recordsFile(tables: Tables, schemaVersion = SCHEMA_VERSION): Buffer { return Buffer.from(canonical({ version: 1, schemaVersion, tables }) + '\n'); }
function csvCell(value: unknown): string {
  const cell = String(value ?? '');
  // A leading apostrophe prevents CSV formula execution when opened in a spreadsheet.
  const safe = /^[=+@\-\t\r]/.test(cell) ? `'${cell}` : cell;
  return `"${safe.replaceAll('"', '""')}"`;
}
function timeCsv(tables: Tables): Buffer {
  const projects = new Map(tables.projects.map(row => [row.id, json(row.data, 'Project')]));
  const assignments = new Map([...tables.draft_times, ...tables.allocations].map(row => [row.time_id, row.invoice_id]));
  const header = ['id', 'date', 'project', 'description', 'minutes', 'category', 'billable', 'approved', 'rateMinor', 'invoiceId'];
  const lines = tables.time_entries.map(row => {
    const data = json(row.data, 'Time entry');
    return [data.id, data.date, projects.get(data.projectId)?.name, data.description, data.minutes,
      data.category, data.billable, data.approved, data.rateMinor, assignments.get(data.id) ?? null].map(csvCell).join(',');
  });
  return Buffer.from([header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n');
}
function schemaSignature(db: Database.Database): string {
  return canonical(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all());
}
const trustedSchema = new Map<number, string>();
function expectedSchema(version: number): string {
  if (!trustedSchema.has(version)) {
    const fresh = new Database(':memory:');
    try { migrate(fresh, version); trustedSchema.set(version, schemaSignature(fresh)); } finally { fresh.close(); }
  }
  return trustedSchema.get(version)!;
}
/** Older supported schemas are validated exactly as written; the workspace store upgrades them after restore. */
function validateSchema(db: Database.Database, version = SCHEMA_VERSION): void {
  db.pragma('query_only = ON');
  db.pragma('trusted_schema = OFF');
  if (db.pragma('user_version', { simple: true }) !== version) fail('Unsupported database schema version.');
  // Never migrate imported SQL. Every persisted table/index/trigger must match our own migration.
  if (schemaSignature(db) !== expectedSchema(version)) fail('Database schema differs from the supported application schema.');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') fail('SQLite integrity check failed.');
  if ((db.pragma('foreign_key_check') as unknown[]).length) fail('SQLite foreign keys are invalid.');
}
function integer(value: unknown, label: string, min = 0, max = MAX_MONEY): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is outside the supported integer range.`);
  return value;
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonical(actual) !== canonical(expected)) fail(`${label} does not match the database snapshot.`);
}
function date(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} is not a calendar date.`);
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} is not a real date.`);
}
function text(value: unknown, label: string, max = 4000, required = false): void {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label} is invalid.`);
}
function bool(value: unknown, label: string): void { if (typeof value !== 'boolean') fail(`${label} must be boolean.`); }
function nullableId(value: unknown, label: string): void { if (value !== null && (typeof value !== 'string' || !UUID.test(value))) fail(`${label} must be a UUID or null.`); }
function record(row: Row, label: string): Row {
  const data = json(row.data, label);
  if (typeof row.id !== 'string' || !UUID.test(row.id) || data.id !== row.id) fail(`${label} record identity is invalid.`);
  integer(data.revision, `${label} revision`, 1, 999_999_999);
  if (typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) fail(`${label} creation time is invalid.`);
  return data;
}
function business(value: unknown, workspace: Workspace): Row {
  const data = object(value, 'Business');
  for (const key of ['name', 'address', 'country', 'region', 'legalForm', 'taxId', 'registrationId', 'paymentInstructions']) text(data[key], `Business ${key}`, 4000);
  bool(data.taxRegistered, 'Tax registration');
  if (data.currency !== workspace.currency) fail('Business currency differs from workspace currency.');
  if (typeof data.invoicePrefix !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(data.invoicePrefix)) fail('Invoice prefix is invalid.');
  integer(data.nextInvoiceNumber, 'Next invoice number', 1, 999_999_999);
  integer(data.revision, 'Business revision', 1, 999_999_999);
  nullableId(data.logoId, 'Business logo');
  tax(0, data.defaultTaxRate as string);
  if (data.vatFrequency !== undefined && !['quarterly', 'monthly', 'annual'].includes(data.vatFrequency as string)) fail('VAT filing frequency is invalid.');
  if (data.smallBusinessScheme !== undefined) bool(data.smallBusinessScheme, 'Small business scheme');
  return data;
}
function optionalText(data: Row, keys: string[], label: string, max = 4000): void { for (const key of keys) if (data[key] !== undefined) text(data[key], `${label} ${key}`, max); }
function rate(value: unknown, label: string): string {
  const exchange = value ?? '1';
  if (typeof exchange !== 'string') fail(`${label} is invalid.`);
  try { toBase(0, exchange); } catch { fail(`${label} is invalid.`); }
  return exchange;
}
function validateRecords(tables: Tables, workspace: Workspace): void {
  const settings = new Map(tables.settings.map(row => [row.key, parseJson(row.data, 'Setting')]));
  equal([...settings.keys()].filter(key => key !== 'operation' && key !== 'vatFilings').sort(), ['business', 'nextCredit', 'timer', 'workspace'], 'Settings keys');
  if (settings.has('vatFilings')) for (const [period, value] of Object.entries(object(settings.get('vatFilings'), 'VAT filings'))) {
    const filing = object(value, 'VAT filing');
    if (filing.period !== period || !/^(Q[1-4] \d{4}|\d{4}-\d{2}|\d{4})$/.test(period) || !['todo', 'filed', 'not-applicable'].includes(filing.status as string)) fail('VAT filing status is invalid.');
    if (filing.filedOn !== null) date(filing.filedOn, 'VAT filing date');
    text(filing.note, 'VAT filing note');
  }
  if (settings.has('operation')) object(settings.get('operation'), 'Last workspace operation');
  if (!settings.has('business')) fail('Business settings are missing.');
  const currentBusiness = business(settings.get('business'), workspace);
  integer(settings.get('nextCredit'), 'Next credit number', 1, 999_999_999);
  const clients = new Map(tables.clients.map(row => {
    const data = record(row, 'Client');
    text(data.name, 'Client name', 200, true); text(data.address, 'Client address');
    text(data.email, 'Client email', 320); text(data.taxId, 'Client tax ID', 100); text(data.country, 'Client country', 2, true);
    optionalText(data, ['contactName', 'registrationId', 'notes'], 'Client');
    return [row.id, data];
  }));
  const projects = new Map(tables.projects.map(row => {
    const data = record(row, 'Project');
    equal(data.clientId, row.client_id, 'Project client');
    if (!clients.has(data.clientId)) fail('Project client is absent.');
    text(data.name, 'Project name', 200, true);
    if (!['hourly', 'fixed'].includes(data.kind as string)) fail('Project pricing type is invalid.');
    integer(data.rateMinor, 'Hourly rate');
    if (data.fixedPriceMinor !== null) integer(data.fixedPriceMinor, 'Fixed contract price');
    if (data.kind === 'fixed' && data.fixedPriceMinor === null) fail('Fixed project has no price.');
    bool(data.costsComplete, 'Cost confirmation');
    if (!['quote', 'active', 'paused', 'complete', 'cancelled'].includes(data.status as string)) fail('Project status is invalid.');
    optionalText(data, ['notes'], 'Project');
    if (data.estimatedRemainingMinutes !== null) integer(data.estimatedRemainingMinutes, 'Remaining minutes', 0, 6_000_000);
    return [row.id, data];
  }));
  const times = new Map(tables.time_entries.map(row => {
    const data = record(row, 'Time entry'); equal(data.projectId, row.project_id, 'Time project');
    if (!projects.has(data.projectId)) fail('Time project is absent.');
    date(data.date, 'Time date'); integer(data.minutes, 'Worked minutes', 1, 1440); integer(data.rateMinor, 'Time rate');
    text(data.description, 'Time description', 200, true); bool(data.billable, 'Billability'); bool(data.approved, 'Time approval');
    text(data.category, 'Time category', 60, true); optionalText(data, ['notes'], 'Time');
    for (const key of ['startTime', 'endTime']) if (data[key] !== undefined && data[key] !== null && (typeof data[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[key] as string))) fail('Time session clock is invalid.');
    // Associations live in reservation/allocation tables; the stored payload stays unassigned.
    equal(data.invoiceId, null, 'Stored time invoice');
    return [row.id, data];
  }));
  const invoices = new Map(tables.invoices.map(row => {
    const data = record(row, 'Invoice'); equal(data.projectId, row.project_id, 'Invoice project'); equal(data.clientId, row.client_id, 'Invoice client');
    equal(data.status, row.status, 'Invoice status'); equal(data.number, row.number, 'Invoice number');
    const project = projects.get(data.projectId);
    if (!project || project.clientId !== data.clientId) fail('Invoice project/client differs.');
    if (typeof data.currency !== 'string' || !isCurrency(data.currency)) fail('Invoice currency is unsupported.');
    const exchange = rate(data.exchangeRate, 'Invoice exchange rate');
    if (data.currency === workspace.currency && exchange !== '1') fail('Workspace-currency invoice has an exchange rate.');
    if (data.taxTreatment !== undefined && !['domestic', 'eu-reverse-charge', 'outside-eu', 'unknown'].includes(data.taxTreatment as string)) fail('Invoice tax treatment is invalid.');
    const frozenBusiness = business(data.business, workspace);
    const frozenClient = object(data.client, 'Invoice client snapshot');
    if (frozenClient.id !== data.clientId) fail('Invoice client snapshot differs.');
    for (const key of ['name', 'address', 'country', 'email', 'taxId']) text(frozenClient[key], `Invoice client ${key}`);
    date(data.issueDate, 'Invoice date'); date(data.supplyDate, 'Supply date'); date(data.dueDate, 'Due date');
    if ((data.dueDate as string) < (data.issueDate as string)) fail('Due date precedes issue date.');
    text(data.notes, 'Invoice notes');
    if (!Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > 600) fail('Invoice lines are invalid.');
    const lines = data.lines.map((value, index) => {
      const line = object(value, 'Invoice line');
      if (typeof line.id !== 'string' || !UUID.test(line.id)) fail('Invoice line identity is invalid.');
      text(line.description, 'Line description', 4000, true); integer(line.unitPriceMinor, 'Line unit price');
      nullableId(line.timeEntryId, 'Line time entry');
      let expectedNet: number;
      if (line.timeEntryId !== null) {
        const time = times.get(line.timeEntryId);
        if (!time || time.projectId !== data.projectId || !time.approved || !time.billable) fail('Invoice time line is invalid.');
        equal(line.timeMinutes, time.minutes, 'Invoice captured integer minutes');
        equal(line.unitPriceMinor, toDocument(time.rateMinor as number, exchange), 'Invoice captured time rate');
        equal(line.quantity, new Decimal(time.minutes as number).div(60).toFixed(6), 'Invoice time quantity');
        expectedNet = timeAmount(time.minutes as number, line.unitPriceMinor as number);
        if (project.kind !== 'hourly') fail('Fixed projects cannot have hourly invoice lines.');
      } else {
        equal(line.timeMinutes, null, 'Non-time invoice minutes');
        expectedNet = lineAmount(line.quantity as string, line.unitPriceMinor as number);
      }
      // Validate the display quantity even when the authoritative amount uses integer minutes.
      lineAmount(line.quantity as string, line.unitPriceMinor as number);
      equal(line.netMinor, expectedNet, `Invoice line ${index + 1} net amount`);
      equal(line.taxMinor, tax(expectedNet, line.taxRate as string), `Invoice line ${index + 1} tax`);
      return line;
    });
    if (new Set(lines.map(line => line.id)).size !== lines.length) fail('Invoice line IDs repeat.');
    if (project.kind === 'fixed' && (lines.length !== 1 || lines[0].quantity !== '1' || lines[0].unitPriceMinor !== toDocument(project.fixedPriceMinor as number, exchange) || lines[0].timeEntryId !== null)) fail('Fixed invoice differs from its one contract charge.');
    equal(data.netMinor, sumMoney(lines.map(line => line.netMinor as number)), 'Invoice net total');
    equal(data.taxMinor, sumMoney(lines.map(line => line.taxMinor as number)), 'Invoice tax total');
    equal(data.totalMinor, sumMoney([data.netMinor as number, data.taxMinor as number]), 'Invoice grand total');
    if (data.baseNetMinor !== undefined) {
      equal(data.baseNetMinor, toBase(data.netMinor as number, exchange), 'Invoice base net'); equal(data.baseTaxMinor, toBase(data.taxMinor as number, exchange), 'Invoice base tax');
      equal(data.baseTotalMinor, sumMoney([data.baseNetMinor as number, data.baseTaxMinor as number]), 'Invoice base total'); equal(data.baseOutstandingMinor, data.baseTotalMinor, 'Stored base balance');
    } else if (exchange !== '1') fail('Foreign-currency invoice has no base amounts.');
    if (data.status === 'issued' && (typeof data.issuedAt !== 'string' || !Number.isFinite(Date.parse(data.issuedAt)))) fail('Issued invoice has no valid issue timestamp.');
    if (data.status === 'issued') {
      equal(data.number, `${frozenBusiness.invoicePrefix}-${(data.issueDate as string).slice(0, 4)}-${String(frozenBusiness.nextInvoiceNumber).padStart(4, '0')}`, 'Issued invoice sequence');
      if ((currentBusiness.nextInvoiceNumber as number) <= (frozenBusiness.nextInvoiceNumber as number)) fail('Invoice sequence has moved backwards.');
    } else equal(data.issuedAt, null, 'Draft issue timestamp');
    // Stored document values precede receipt/credit history; the API derives the live balances.
    equal(data.paidMinor, 0, 'Stored document paid amount'); equal(data.creditedMinor, 0, 'Stored document credit amount');
    equal(data.outstandingMinor, data.totalMinor, 'Stored document original balance');
    equal(data.issueBlockers, [], 'Stored issue blockers');
    return [row.id, data];
  }));
  const assignment = new Map<unknown, unknown>();
  for (const [table, status] of [['draft_times', 'draft'], ['allocations', 'issued']] as const) {
    for (const row of tables[table]) {
      const time = times.get(row.time_id); const invoice = invoices.get(row.invoice_id);
      if (assignment.has(row.time_id) || !time || !invoice || invoice.status !== status || time.projectId !== invoice.projectId || !time.billable || !time.approved) fail('Time reservation/allocation is invalid or repeated.');
      assignment.set(row.time_id, row.invoice_id);
    }
  }
  for (const [id, invoice] of invoices) {
    const lineTimes = (invoice.lines as Row[]).filter(line => line.timeEntryId !== null).map(line => line.timeEntryId);
    if (new Set(lineTimes).size !== lineTimes.length) fail('Time is charged twice in an invoice.');
    for (const timeId of lineTimes) equal(assignment.get(timeId), id, 'Invoice line time assignment');
    equal([...assignment].filter(([, invoiceId]) => invoiceId === id).map(([timeId]) => timeId).sort(), [...lineTimes].sort(), 'Invoice reservation set');
  }
  for (const project of projects.values()) if (project.kind === 'fixed' && [...invoices.values()].filter(invoice => invoice.projectId === project.id).length > 1) fail('Fixed project has multiple invoices.');
  const payments = new Map(tables.payments.map(row => {
    const data = record(row, 'Payment'); equal(data.invoiceId, row.invoice_id, 'Payment invoice'); equal(data.reversalOf, row.reversal_of, 'Payment reversal');
    const invoice = invoices.get(row.invoice_id);
    if (!invoice || invoice.status !== 'issued') fail('Payment needs an issued invoice.');
    date(data.date, 'Payment date'); text(data.reference, 'Payment reference');
    integer(data.amountMinor, 'Payment amount', -MAX_MONEY);
    if (data.amountMinor === 0 || (data.reversalOf === null && (data.amountMinor as number) < 0)) fail('Payment amount/sign is invalid.');
    nullableId(data.reversalOf, 'Reversed payment');
    return [row.id, data];
  }));
  for (const payment of payments.values()) if (payment.reversalOf !== null) {
    const original = payments.get(payment.reversalOf);
    if (!original || original.reversalOf !== null || original.invoiceId !== payment.invoiceId || payment.amountMinor !== -(original.amountMinor as number)) fail('Payment reversal differs from original receipt.');
  }
  const credits = tables.credits.map(row => {
    const data = record(row, 'Credit'); equal(data.invoiceId, row.invoice_id, 'Credit invoice'); equal(data.number, row.number, 'Credit number');
    const invoice = invoices.get(data.invoiceId);
    if (!invoice || invoice.status !== 'issued') fail('Credit needs an issued invoice.');
    date(data.date, 'Credit date'); text(data.reason, 'Credit reason', 200, true);
    integer(data.netMinor, 'Credit net', 1); integer(data.taxMinor, 'Credit tax');
    if (typeof data.number !== 'string' || !/^CN-\d{4}-\d{4,9}$/.test(data.number) || !data.number.startsWith(`CN-${(data.date as string).slice(0, 4)}-`)) fail('Credit sequence is invalid.');
    if ((settings.get('nextCredit') as number) <= Number(data.number.split('-')[2])) fail('Credit sequence has moved backwards.');
    equal(data.totalMinor, sumMoney([data.netMinor as number, data.taxMinor as number]), 'Credit total');
    const exchange = rate(invoice.exchangeRate, 'Invoice exchange rate');
    if (data.baseNetMinor !== undefined) { equal(data.baseNetMinor, toBase(data.netMinor as number, exchange), 'Credit base net'); equal(data.baseTaxMinor, toBase(data.taxMinor as number, exchange), 'Credit base tax'); }
    else if (exchange !== '1') fail('Foreign-currency credit has no base amounts.');
    return data;
  });
  for (const [id, invoice] of invoices) {
    const paid = sumMoney([...payments.values()].filter(payment => payment.invoiceId === id).map(payment => payment.amountMinor as number));
    const credited = sumMoney(credits.filter(credit => credit.invoiceId === id).map(credit => credit.totalMinor as number));
    const creditNet = sumMoney(credits.filter(credit => credit.invoiceId === id).map(credit => credit.netMinor as number));
    const creditTax = sumMoney(credits.filter(credit => credit.invoiceId === id).map(credit => credit.taxMinor as number));
    if (creditTax > (invoice.taxMinor as number) || (creditNet === invoice.netMinor && creditTax !== invoice.taxMinor)) fail('Credit tax differs from the invoice tax.');
    if (paid < 0 || paid > (invoice.totalMinor as number) || credited > (invoice.totalMinor as number) || creditNet > (invoice.netMinor as number)) fail('Invoice payments or credits exceed the supported invoice amounts.');
    sumMoney([invoice.totalMinor as number, -paid, -credited]); // Signed negative balances represent refunds due.
    let remainingNet = invoice.netMinor as number; let remainingTax = invoice.taxMinor as number;
    for (const credit of credits.filter(item => item.invoiceId === id).sort((a, b) => Number((a.number as string).split('-')[2]) - Number((b.number as string).split('-')[2]))) {
      const rates = new Set((invoice.lines as Row[]).map(line => line.taxRate));
      if (rates.size !== 1) fail('Mixed-tax credits are not supported.');
      const expectedTax = credit.netMinor === remainingNet ? remainingTax : Math.min(remainingTax, tax(credit.netMinor as number, [...rates][0] as string));
      equal(credit.taxMinor, expectedTax, 'Credit tax calculation');
      remainingNet -= credit.netMinor as number; remainingTax -= credit.taxMinor as number;
    }
  }
  const attachments = new Map(tables.attachments.map(row => [row.id, row]));
  const logoReferences = [currentBusiness.logoId, ...[...invoices.values()].map(invoice => object(invoice.business, 'Business').logoId)];
  for (const id of logoReferences) if (id !== null && (!attachments.has(id) || !['image/png', 'image/jpeg'].includes(attachments.get(id)?.mime as string))) fail('Logo attachment is missing or has an unsupported format.');
  for (const row of tables.expenses) {
    const data = record(row, 'Expense'); equal(data.projectId, row.project_id, 'Expense project'); equal(data.attachmentId, row.attachment_id, 'Expense attachment');
    if (data.projectId !== null && !projects.has(data.projectId)) fail('Expense project is absent.');
    date(data.date, 'Expense date'); text(data.description, 'Expense description', 200, true);
    integer(data.netMinor, 'Expense net'); integer(data.taxMinor, 'Expense tax'); bool(data.deductibleTax, 'Expense tax deductibility');
    const vat = data.vatTreatment ?? 'standard', reverse = data.reverseChargeTaxMinor ?? 0;
    if (!['standard', 'none', ...REVERSE_CHARGE].includes(vat as string) || (vat !== 'standard' && data.taxMinor !== 0)) fail('Expense VAT treatment is invalid.');
    integer(reverse, 'Reverse-charge VAT'); if (!REVERSE_CHARGE.includes(vat as string) && reverse !== 0) fail('Reverse-charge VAT without reverse charge.');
    optionalText(data, ['supplier', 'category', 'paymentMethod'], 'Expense', 200); optionalText(data, ['supplierInvoiceNumber'], 'Expense', 100); optionalText(data, ['notes'], 'Expense');
    if (data.country !== undefined) text(data.country, 'Expense country', 2);
    if (data.originalCurrency !== undefined && data.originalCurrency !== '' && !isCurrency(data.originalCurrency as string)) fail('Expense original currency is unsupported.');
    if (data.originalAmountMinor !== undefined && data.originalAmountMinor !== null) integer(data.originalAmountMinor, 'Expense original amount');
    equal(data.costMinor, sumMoney([data.netMinor as number, data.deductibleTax ? 0 : data.taxMinor as number, data.deductibleTax ? 0 : reverse as number]), 'Direct cost');
    nullableId(data.attachmentId, 'Expense attachment');
    if (data.attachmentId !== null && !attachments.has(data.attachmentId)) fail('Expense attachment is absent.');
  }
  const timerValue = settings.get('timer');
  if (timerValue !== null) {
    const timer = object(timerValue, 'Timer');
    if (!projects.has(timer.projectId) || typeof timer.startedAt !== 'string' || !Number.isFinite(Date.parse(timer.startedAt))) fail('Running timer is invalid.');
    text(timer.description, 'Timer description', 200, true); bool(timer.billable, 'Timer billability');
    text(timer.category, 'Timer category', 60, true);
  }
  for (const row of tables.audit_events) {
    const data = record(row, 'Audit event'); text(data.type, 'Audit operation', 100, true); nullableId(data.recordId, 'Audit record');
  }
}
function attachmentBytes(db: Database.Database, tables: Tables): Map<string, Buffer> {
  const files = new Map<string, Buffer>(); let total = 0;
  for (const row of tables.attachments) {
    if (typeof row.id !== 'string' || !UUID.test(row.id)) fail('Attachment ID is invalid.');
    if (typeof row.name !== 'string' || !row.name || row.name.length > 200 || /[\\/\x00-\x1f]/.test(row.name)) fail('Attachment original name is invalid.');
    integer(row.size, 'Attachment size', 1, 5 * 1024 * 1024);
    if (typeof row.sha256 !== 'string' || !HASH.test(row.sha256)) fail('Attachment hash is invalid.');
    const bytes = (db.prepare('SELECT bytes FROM attachments WHERE id=?').get(row.id) as {bytes: Buffer}).bytes;
    if (!Buffer.isBuffer(bytes) || bytes.length !== row.size || sha256(bytes) !== row.sha256) fail('Attachment bytes differ from metadata.');
    const valid = row.mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
      row.mime === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      row.mime === 'application/pdf' ? bytes.subarray(0, 5).toString('ascii') === '%PDF-' : false;
    if (!valid) fail('Attachment MIME type/file signature differs.');
    total += bytes.length; if (total > MAX_ATTACHMENTS) fail('Attachments exceed the 50 MiB workspace limit.');
    files.set(`attachments/${row.id}`, bytes);
  }
  return files;
}
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function zipDirectory(buffer: Buffer): {count: number; offset: number} {
  // Check the tiny end record before a ZIP library can allocate from an attacker-controlled count.
  for (let end = buffer.length - 22; end >= Math.max(0, buffer.length - 65_557); end--) {
    if (buffer.readUInt32LE(end) !== 0x06054b50 || end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length) continue;
    const count = buffer.readUInt16LE(end + 10); const offset = buffer.readUInt32LE(end + 16); const size = buffer.readUInt32LE(end + 12);
    if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 || buffer.readUInt16LE(end + 8) !== count) fail('Multi-disk ZIP archives are not supported.');
    if (count < 4 || count > MAX_ENTRIES) fail('Archive has an unsupported number of entries.');
    if (offset === 0xffffffff || size === 0xffffffff || offset + size !== end || size < count * 46) fail('ZIP directory is invalid or unsupported.');
    return {count, offset};
  }
  return fail('ZIP end record is missing or unsupported.');
}
function unzip(buffer: Buffer): Map<string, Buffer> {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ARCHIVE) fail('Archive size exceeds the supported limit.');
  const directory = zipDirectory(buffer);
  const zip = new AdmZip(buffer); const entries = zip.getEntries();
  if (entries.length !== directory.count) fail('ZIP entry count differs from its directory.');
  const files = new Map<string, Buffer>(); let total = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    if (files.has(name) || !(['manifest.json', 'database.sqlite', 'records.json', 'time.csv'].includes(name) || /^attachments\/[0-9a-f-]{36}$/i.test(name)) || entry.isDirectory) fail('Archive contains unknown, duplicate or unsafe paths.');
    if (name.startsWith('attachments/') && !UUID.test(name.slice(12))) fail('Attachment path is invalid.');
    if ((entry.header.flags & 1) !== 0 || ![0, 8].includes(entry.header.method)) fail('Encrypted or unsupported ZIP entries are not supported.');
    const offset = entry.header.offset;
    if (offset < 0 || offset + 30 > directory.offset || buffer.readUInt32LE(offset) !== 0x04034b50) fail('ZIP local header is invalid.');
    const localFlags = buffer.readUInt16LE(offset + 6); const nameLength = buffer.readUInt16LE(offset + 26); const extraLength = buffer.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    if (localFlags !== entry.header.flags || buffer.readUInt16LE(offset + 8) !== entry.header.method || !buffer.subarray(offset + 30, offset + 30 + nameLength).equals(entry.rawEntryName) || dataOffset + entry.header.compressedSize > directory.offset) fail('ZIP local and directory headers differ.');
    integer(entry.header.size, 'ZIP entry size', 0, MAX_ARCHIVE);
    total += entry.header.size;
    if (total > MAX_ARCHIVE || (name === 'manifest.json' && entry.header.size > 512 * 1024)) fail('Archive expands beyond the supported limit.');
    const compressed = buffer.subarray(dataOffset, dataOffset + entry.header.compressedSize);
    const bytes = entry.header.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.header.size) });
    if (bytes.length !== entry.header.size || crc32(bytes) !== (entry.header.crc >>> 0)) fail('ZIP entry size or checksum is invalid.');
    files.set(name, bytes);
  }
  return files;
}

/** Snapshot through SQLite's online backup API; active data is never copied file-by-file. */
export async function createBackup(db: Database.Database): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'billable-backup-'));
  let snapshot: Database.Database | undefined;
  try {
    const path = join(directory, 'snapshot.sqlite');
    await db.backup(path);
    snapshot = new Database(path, { readonly: true, fileMustExist: true });
    validateSchema(snapshot);
    const workspace = workspaceFrom(snapshot); const tables = rowsFrom(snapshot);
    validateRecords(tables, workspace);
    const files = attachmentBytes(snapshot, tables);
    snapshot.close(); snapshot = undefined;
    files.set('database.sqlite', await readFile(path));
    files.set('records.json', recordsFile(tables)); files.set('time.csv', timeCsv(tables));
    const manifest: Manifest = {
      format: 'billable-backup', version: 1, schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(), workspace,
      counts: Object.fromEntries(BACKUP_TABLES.map(table => [table, tables[table].length])),
      files: Object.fromEntries([...files].map(([name, bytes]) => [name, { size: bytes.length, sha256: sha256(bytes) }])),
    };
    const zip = new AdmZip();
    for (const [name, bytes] of files) zip.addFile(name, bytes);
    zip.addFile('manifest.json', Buffer.from(canonical(manifest) + '\n'));
    const buffer = zip.toBuffer();
    await validateBackup(buffer);
    return buffer;
  } finally { snapshot?.close(); await rm(directory, { recursive: true, force: true }); }
}

/** Fully validates a portable backup before the caller creates or activates a new workspace. */
export async function validateBackup(buffer: Buffer): Promise<{ database: Buffer; workspace: Workspace }> {
  let files: Map<string, Buffer>;
  try { files = unzip(buffer); } catch (error) { throw new Error(`Invalid backup archive: ${(error as Error).message}`); }
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) fail('Manifest is missing.');
  const manifest = json(manifestBytes.toString('utf8'), 'Manifest') as unknown as Manifest;
  if (manifest.format !== 'billable-backup' || manifest.version !== 1 || typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion < OLDEST_SUPPORTED_SCHEMA || manifest.schemaVersion > SCHEMA_VERSION) fail('Unsupported backup format/version.');
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) fail('Backup creation time is invalid.');
  object(manifest.files, 'File manifest'); object(manifest.counts, 'Record counts');
  equal(Object.keys(manifest.files).sort(), [...files.keys()].filter(name => name !== 'manifest.json').sort(), 'Manifest entries');
  for (const [name, bytes] of files) if (name !== 'manifest.json') {
    const metadata = object(manifest.files[name], 'File metadata');
    if (metadata.size !== bytes.length || metadata.sha256 !== sha256(bytes)) fail(`File hash/size differs: ${name}.`);
  }
  const database = files.get('database.sqlite');
  if (!database || database.length < 100 || database.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') fail('SQLite snapshot is missing or invalid.');
  const directory = await mkdtemp(join(tmpdir(), 'billable-validate-'));
  let db: Database.Database | undefined;
  try {
    const path = join(directory, 'snapshot.sqlite'); await writeFile(path, database, { flag: 'wx' });
    db = new Database(path, { readonly: true, fileMustExist: true });
    validateSchema(db, manifest.schemaVersion);
    const workspace = workspaceFrom(db); const tables = rowsFrom(db);
    equal(manifest.workspace, workspace, 'Workspace metadata');
    equal(manifest.counts, Object.fromEntries(BACKUP_TABLES.map(table => [table, tables[table].length])), 'Record counts');
    const records = files.get('records.json'); const csv = files.get('time.csv');
    if (!records || !csv) fail('Analysis exports are missing.');
    if (!records.equals(recordsFile(tables, manifest.schemaVersion)) || !csv.equals(timeCsv(tables))) fail('Analysis exports differ from the database snapshot.');
    validateRecords(tables, workspace);
    const attachments = attachmentBytes(db, tables);
    equal([...files.keys()].filter(name => name.startsWith('attachments/')).sort(), [...attachments.keys()].sort(), 'Attachment files');
    for (const [name, bytes] of attachments) if (!files.get(name)?.equals(bytes)) fail(`Original attachment differs: ${name}.`);
    return { database, workspace };
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceStore, localDate } from '../server/store.js';
import { migrate, SCHEMA_VERSION } from '../server/schema.js';
import { createBackup, validateBackup } from '../server/backup.js';
import { toBase, toDocument } from '../shared/money.js';
import type { BusinessProfile, Command, Workspace } from '../shared/types.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'billable-ledger-test-'));
  const path = join(directory, 'workspace.sqlite');
  const workspace: Workspace = { id: randomUUID(), name: 'Ledger test', demo: false, currency: 'EUR' };
  const store = new WorkspaceStore(path, workspace);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const exec = (command: Command) => store.execute(command).createdId ?? '';
  return { store, exec, directory, path };
}
type Fixture = ReturnType<typeof fixture>;
function supplier(f: Fixture, changes: Partial<BusinessProfile> = {}) {
  const { logoId: _logo, ...profile } = f.store.state().business;
  f.exec({ type: 'business.update', data: { ...profile, name: 'Fictional Test Studio', address: '42 Example Lane\n1234 AB Amsterdam', country: 'NL', legalForm: 'Sole proprietor', taxRegistered: true, taxId: 'NL000000000B00', registrationId: '00000000', ...changes } });
}
function customer(f: Fixture, country: string, taxId = '') {
  const clientId = f.exec({ type: 'client.create', data: { name: `Fictional ${country} client`, address: '8 Example Street\nExample City', country, email: '', taxId, contactName: 'A. Example' } });
  const projectId = f.exec({ type: 'project.create', data: { clientId, name: `${country} project`, kind: 'hourly', rate: '100.00', fixedPrice: null, costsComplete: true, status: 'active', estimatedRemainingMinutes: null } });
  return { clientId, projectId };
}
function hour(f: Fixture, projectId: string, minutes = 60) {
  return f.exec({ type: 'time.create', data: { projectId, date: '2026-09-01', minutes, description: 'Fictional delivery', category: 'Delivery', billable: true, approved: true } });
}
function invoice(f: Fixture, projectId: string, timeIds: string[], taxRate: string, extra: Partial<{ currency: string; exchangeRate: string }> = {}) {
  return f.exec({ type: 'invoice.draft', data: { projectId, timeEntryIds: timeIds, issueDate: '2026-09-02', supplyDate: '2026-09-01', dueDate: '2026-10-02', taxRate, notes: '', extraLines: [], ...extra } });
}
const find = (f: Fixture, id: string) => f.store.state().invoices.find(item => item.id === id)!;

test('exchange conversions round once in each direction', () => {
  assert.equal(toDocument(10_000, '1.1'), 11_000);
  assert.equal(toBase(16_500, '1.1'), 15_000);
  assert.equal(toBase(6_500, '1.1'), 5_909);
  assert.throws(() => toBase(100, '0'));
});

test('a foreign-currency invoice converts prices once and reports revenue in the workspace currency', t => {
  const f = fixture(t); supplier(f);
  const { projectId } = customer(f, 'US');
  const id = invoice(f, projectId, [hour(f, projectId, 90)], '0', { currency: 'USD', exchangeRate: '1.1' });
  let doc = find(f, id);
  assert.equal(doc.currency, 'USD'); assert.equal(doc.taxTreatment, 'outside-eu');
  assert.equal(doc.lines[0].unitPriceMinor, 11_000); assert.equal(doc.netMinor, 16_500); assert.equal(doc.baseNetMinor, 15_000);
  assert.deepEqual(doc.issueBlockers, []);
  f.exec({ type: 'invoice.issue', data: { id, revision: doc.revision } });
  f.exec({ type: 'payment.create', data: { invoiceId: id, date: '2026-09-20', amount: '100.00', reference: 'Fictional USD receipt' } });
  const state = f.store.state(); doc = find(f, id);
  assert.equal(doc.outstandingMinor, 6_500); assert.equal(doc.baseOutstandingMinor, 5_909);
  assert.equal(state.totals.outstandingMinor, 5_909);
  assert.equal(state.insights[0].revenueMinor, 15_000);
  const q3 = state.vatPeriods.find(period => period.period === 'Q3 2026')!;
  assert.equal(q3.rows.find(row => row.code === 'outside')!.netMinor, 15_000);
  assert.equal(q3.dueMinor, 0);
  assert.throws(() => invoice(f, projectId, [hour(f, projectId)], '0', { currency: 'USD' }), /exchange rate/);
});

test('EU business customers need a VAT ID and 0% reverse charge; domestic lines allow 21% and 9%', t => {
  const f = fixture(t); supplier(f);
  const eu = customer(f, 'DE');
  const missingId = invoice(f, eu.projectId, [hour(f, eu.projectId)], '0');
  assert.ok(find(f, missingId).issueBlockers.some(text => text.includes('EU VAT ID')));
  const client = f.store.state().clients.find(item => item.id === eu.clientId)!;
  f.exec({ type: 'client.update', data: { id: client.id, revision: client.revision, name: client.name, address: client.address, country: 'DE', email: '', taxId: 'DE000000000' } });
  assert.deepEqual(find(f, missingId).issueBlockers, []);
  const taxed = invoice(f, eu.projectId, [hour(f, eu.projectId)], '21');
  assert.ok(find(f, taxed).issueBlockers.some(text => text.includes('reverse-charged')));
  const nl = customer(f, 'NL');
  assert.deepEqual(find(f, invoice(f, nl.projectId, [hour(f, nl.projectId)], '9')).issueBlockers, []);
  assert.ok(find(f, invoice(f, nl.projectId, [hour(f, nl.projectId)], '0')).issueBlockers.some(text => text.includes('21% or 9%')));
  const unknown = customer(f, 'ZZ');
  assert.ok(find(f, invoice(f, unknown.projectId, [hour(f, unknown.projectId)], '0')).issueBlockers.some(text => text.includes('customer country')));
});

test('VAT overview groups sales, reverse-charged purchases, input VAT and credits by period', t => {
  const f = fixture(t); supplier(f);
  const nl = customer(f, 'NL');
  const id = invoice(f, nl.projectId, [hour(f, nl.projectId)], '21');
  f.exec({ type: 'invoice.issue', data: { id, revision: 1 } });
  f.exec({ type: 'expense.create', data: { projectId: null, date: '2026-09-05', description: 'Fictional software', netAmount: '100.00', taxAmount: '21.00', deductibleTax: true, category: 'Software', supplier: 'Fictional NL Supplier', country: 'NL', paymentMethod: 'Credit card', attachment: null } });
  f.exec({ type: 'expense.create', data: { projectId: null, date: '2026-09-06', description: 'Fictional US tool', netAmount: '50.00', taxAmount: '0', deductibleTax: true, vatTreatment: 'import-non-eu', country: 'US', originalCurrency: 'USD', originalAmount: '55.00', attachment: null } });
  assert.throws(() => f.exec({ type: 'expense.create', data: { projectId: null, date: '2026-09-06', description: 'Wrong VAT', netAmount: '50.00', taxAmount: '1.00', deductibleTax: true, vatTreatment: 'none', attachment: null } }), /tax amount/);
  let q3 = f.store.state().vatPeriods.find(period => period.period === 'Q3 2026')!;
  const row = (code: string) => q3.rows.find(item => item.code === code)!;
  assert.deepEqual([row('1a').netMinor, row('1a').taxMinor, row('4a').netMinor, row('4a').taxMinor], [10_000, 2_100, 5_000, 1_050]);
  assert.deepEqual([q3.dueMinor, q3.inputMinor, q3.balanceMinor], [3_150, 3_150, 0]);
  f.exec({ type: 'credit.create', data: { invoiceId: id, date: '2026-09-10', netAmount: '20.00', reason: 'Fictional correction' } });
  const state = f.store.state(); q3 = state.vatPeriods.find(period => period.period === 'Q3 2026')!;
  assert.deepEqual([row('1a').netMinor, row('1a').taxMinor, q3.dueMinor, q3.balanceMinor], [8_000, 1_680, 2_730, -420]);
  assert.equal(state.totals.generalCostsMinor, 15_000);
  assert.equal(state.totals.directCostsMinor, 0);
  const september = state.months.find(month => month.month === '2026-09')!;
  assert.deepEqual([september.revenueMinor, september.costsMinor, september.resultMinor, september.workedMinutes], [8_000, 15_000, -7_000, 60]);
  assert.deepEqual(state.years.find(year => year.year === '2026'), { year: '2026', revenueMinor: 8_000, costsMinor: 15_000, resultMinor: -7_000, workedMinutes: 60, billableMinutes: 60 });
  assert.ok(state.vatPeriods.some(period => period.period === `Q${Math.ceil(Number(localDate().slice(5, 7)) / 3)} ${localDate().slice(0, 4)}`));
});

test('VAT filing status is recorded per period and never in the future', t => {
  const f = fixture(t);
  f.exec({ type: 'vat.filing', data: { period: 'Q3 2026', status: 'filed', filedOn: null, note: 'Fictional filing' } });
  const filing = f.store.state().vatPeriods.find(period => period.period === 'Q3 2026')?.filing ?? f.store.setting<Record<string, { filedOn: string }>>('vatFilings')['Q3 2026'];
  assert.equal(filing?.filedOn, localDate());
  assert.throws(() => f.exec({ type: 'vat.filing', data: { period: 'Q3 2026', status: 'filed', filedOn: '2999-01-01', note: '' } }), /future/);
});

test('expenses can be general business costs and edited with the same VAT rules', t => {
  const f = fixture(t); supplier(f);
  const { projectId } = customer(f, 'NL');
  // An unspecified supplier country is allowed, as the form sends it.
  const id = f.exec({ type: 'expense.create', data: { projectId: null, date: '2026-09-05', description: 'Fictional subscription', netAmount: '10.00', taxAmount: '2.10', deductibleTax: false, country: '', attachment: null } });
  let expense = f.store.state().expenses[0];
  assert.equal(expense.projectId, null); assert.equal(expense.costMinor, 1_210); assert.equal(expense.originalCurrency, 'EUR');
  f.exec({ type: 'expense.update', data: { id, revision: expense.revision, projectId, date: '2026-09-05', description: 'Fictional subscription', netAmount: '10.00', taxAmount: '0', deductibleTax: false, vatTreatment: 'intra-eu', country: 'IE', supplier: 'Fictional IE Ltd', category: 'Software' } });
  expense = f.store.state().expenses[0];
  assert.equal(expense.projectId, projectId); assert.equal(expense.reverseChargeTaxMinor, 210); assert.equal(expense.costMinor, 1_210);
  assert.equal(f.store.state().insights[0].directCostsMinor, 1_210);
});

test('time keeps optional start/end times, notes and custom categories', t => {
  const f = fixture(t);
  const { projectId } = customer(f, 'NL');
  const base = { projectId, date: '2026-09-01', description: 'Fictional workshop', billable: true, approved: true } as const;
  const id = f.exec({ type: 'time.create', data: { ...base, minutes: 90, category: 'Workshop design', startTime: '09:00', endTime: '10:30', notes: 'Fictional participants' } });
  assert.throws(() => f.exec({ type: 'time.create', data: { ...base, minutes: 60, category: 'Delivery', startTime: '09:00', endTime: '10:30' } }));
  let entry = f.store.state().timeEntries[0];
  assert.deepEqual([entry.category, entry.startTime, entry.endTime, entry.notes], ['Workshop design', '09:00', '10:30', 'Fictional participants']);
  // Approving from a list omits the session fields; they are kept when the duration is unchanged.
  f.exec({ type: 'time.update', data: { ...base, id, revision: entry.revision, minutes: 90, category: 'Workshop design' } });
  entry = f.store.state().timeEntries[0];
  assert.deepEqual([entry.startTime, entry.notes], ['09:00', 'Fictional participants']);
});

test('any ISO currency can be the workspace currency before records exist', t => {
  const f = fixture(t);
  supplier(f, { currency: 'CHF', vatFrequency: 'monthly' });
  const state = f.store.state();
  assert.equal(state.workspace.currency, 'CHF'); assert.equal(state.business.vatFrequency, 'monthly');
  assert.throws(() => supplier(f, { currency: 'XXX' }));
});

test('backups with foreign invoices, general costs and VAT filings validate', async t => {
  const f = fixture(t); supplier(f);
  const { projectId } = customer(f, 'GB');
  const id = invoice(f, projectId, [hour(f, projectId, 45)], '0', { currency: 'GBP', exchangeRate: '0.86' });
  f.exec({ type: 'invoice.issue', data: { id, revision: 1 } });
  f.exec({ type: 'credit.create', data: { invoiceId: id, date: '2026-09-15', netAmount: '10.00', reason: 'Fictional correction' } });
  f.exec({ type: 'expense.create', data: { projectId: null, date: '2026-09-05', description: 'Fictional general cost', netAmount: '40.00', taxAmount: '0', deductibleTax: true, vatTreatment: 'reverse-domestic', attachment: null } });
  f.exec({ type: 'vat.filing', data: { period: 'Q3 2026', status: 'not-applicable', filedOn: null, note: '' } });
  const restored = await validateBackup(await createBackup(f.store.db));
  assert.equal(restored.workspace.currency, 'EUR');
});

test('schema v1 workspaces upgrade in place and keep their expenses', t => {
  const directory = mkdtempSync(join(tmpdir(), 'billable-migrate-test-'));
  const path = join(directory, 'workspace.sqlite');
  const legacy = new WorkspaceStore(join(directory, 'seed.sqlite'), { id: randomUUID(), name: 'Seed', demo: false, currency: 'EUR' });
  const old = new Database(path); migrate(old, 1);
  const copy = (table: string) => { for (const row of legacy.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) old.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row)); };
  copy('settings');
  const client = randomUUID(), project = randomUUID(), expense = randomUUID(), now = new Date().toISOString();
  old.prepare('INSERT INTO clients VALUES(?,?)').run(client, JSON.stringify({ id: client, revision: 1, createdAt: now, name: 'Legacy client', address: '', country: 'NL', email: '', taxId: '' }));
  old.prepare('INSERT INTO projects VALUES(?,?,?)').run(project, client, JSON.stringify({ id: project, revision: 1, createdAt: now, clientId: client, name: 'Legacy', kind: 'hourly', rateMinor: 100, fixedPriceMinor: null, costsComplete: false, status: 'active', estimatedRemainingMinutes: null }));
  old.prepare('INSERT INTO expenses VALUES(?,?,?,?)').run(expense, project, null, JSON.stringify({ id: expense, revision: 1, createdAt: now, projectId: project, date: '2026-09-01', description: 'Legacy cost', netMinor: 500, taxMinor: 0, deductibleTax: true, costMinor: 500, attachmentId: null }));
  old.close(); legacy.close();
  const store = new WorkspaceStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  const state = store.state();
  assert.equal(state.expenses[0].projectId, project); assert.equal(state.expenses[0].vatTreatment, 'standard'); assert.equal(state.clients[0].contactName, '');
  store.execute({ type: 'expense.create', data: { projectId: null, date: '2026-09-02', description: 'General cost after upgrade', netAmount: '1.00', taxAmount: '0', deductibleTax: true, attachment: null } });
  assert.equal(store.state().expenses.length, 2);
});

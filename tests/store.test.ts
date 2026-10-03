import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, seedDemo } from '../server/store.js';
import { WorkspaceManager } from '../server/manager.js';
import { AppError } from '../server/validation.js';
import { MAX_MONEY } from '../shared/money.js';
import type { BusinessProfile, Command, ProjectInput, TimeInput, Workspace } from '../shared/types.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'billable-store-test-'));
  const path = join(directory, 'workspace.sqlite');
  const workspace: Workspace = { id: randomUUID(), name: 'Test ledger', demo: false, currency: 'EUR' };
  let store = new WorkspaceStore(path, workspace);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, path, workspace, reopen() { store.close(); store = new WorkspaceStore(path); return store; } };
}

function execute(store: WorkspaceStore, command: Command, requestId?: string): string {
  return store.execute(command, requestId).createdId ?? '';
}

function business(store: WorkspaceStore, changes: Partial<BusinessProfile> = {}) {
  const { logoId: _logoId, ...profile } = store.state().business;
  execute(store, { type: 'business.update', data: { ...profile, name: 'Fictional Test Studio', address: '42 Example Lane\n1234 AB Amsterdam', country: 'NL', legalForm: 'Sole proprietor', taxRegistered: true, taxId: 'NL000000000B00', registrationId: '00000000', ...changes } });
}

function project(store: WorkspaceStore, changes: Partial<ProjectInput> = {}) {
  const clientId = execute(store, { type: 'client.create', data: { name: 'Fictional Client', address: '8 Example Street\n1234 CD Amsterdam', country: 'NL', email: '', taxId: '' } });
  const input: ProjectInput = { clientId, name: 'Example project', kind: 'hourly', rate: '100.00', fixedPrice: null, costsComplete: true, status: 'complete', estimatedRemainingMinutes: 0, ...changes };
  const id = execute(store, { type: 'project.create', data: input });
  return { id, clientId, input };
}

function time(store: WorkspaceStore, projectId: string, changes: Partial<TimeInput> = {}) {
  return execute(store, { type: 'time.create', data: { projectId, date: '2026-09-01', minutes: 60, description: 'Project delivery', category: 'Delivery', billable: true, approved: true, ...changes } });
}

function draft(store: WorkspaceStore, projectId: string, timeEntryIds: string[] = [], extraLines: { description: string; quantity: string; unitPrice: string; taxRate: string }[] = []) {
  return execute(store, { type: 'invoice.draft', data: { projectId, timeEntryIds, issueDate: '2026-09-02', supplyDate: '2026-09-01', dueDate: '2026-10-02', taxRate: '21', notes: 'Fictional test invoice', extraLines } });
}

function issue(store: WorkspaceStore, id: string) {
  const invoice = store.state().invoices.find(i => i.id === id)!;
  execute(store, { type: 'invoice.issue', data: { id, revision: invoice.revision } });
  return store.state().invoices.find(i => i.id === id)!;
}

function code(expected: string) {
  return (error: unknown) => error instanceof AppError && error.code === expected;
}

test('saved records, reservations, attachments and timer persist after closing and reopening SQLite', t => {
  const f = fixture(t), p = project(f.store), timeId = time(f.store, p.id);
  const invoiceId = draft(f.store, p.id, [timeId]);
  const bytes = Buffer.from('%PDF-1.4\nFictional test receipt\n%%EOF');
  execute(f.store, { type: 'expense.create', data: { projectId: p.id, date: '2026-09-01', description: 'Example materials', netAmount: '12.34', taxAmount: '2.59', deductibleTax: false, attachment: { name: 'fictional-receipt.pdf', mime: 'application/pdf', base64: bytes.toString('base64') } } });
  execute(f.store, { type: 'timer.start', data: { projectId: p.id, description: 'Aftercare', category: 'Aftercare', billable: false } });
  const before = f.store.state();
  f.reopen();
  assert.deepEqual(f.store.state(), before);
  assert.equal(f.store.state().timeEntries[0].invoiceId, invoiceId);
  assert.deepEqual(f.store.attachmentBytes(before.attachments[0].id).bytes, bytes);
  assert.equal(before.expenses[0].costMinor, 1493);
});

test('same request is idempotent across process restarts and reuse for another operation conflicts', t => {
  const f = fixture(t), requestId = randomUUID();
  const command: Command = { type: 'client.create', data: { name: 'Only one client', address: '', country: 'NL', email: '', taxId: '' } };
  const first = f.store.execute(command, requestId);
  assert.deepEqual(f.store.execute(command, requestId), first);
  f.reopen();
  assert.deepEqual(f.store.execute(command, requestId), first);
  assert.equal(f.store.state().clients.length, 1);
  assert.throws(() => f.store.execute({ ...command, data: { ...command.data, name: 'Different intent' } }, requestId), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.store.state().clients.length, 1);
});

test('time approval, billability, project membership and duplicate selection are enforced', t => {
  const f = fixture(t), p = project(f.store), other = project(f.store);
  const unapproved = time(f.store, p.id, { approved: false });
  const unpaid = time(f.store, p.id, { billable: false });
  const wrongProject = time(f.store, other.id);
  const good = time(f.store, p.id);
  const before = f.store.state();
  for (const id of [unapproved, unpaid, wrongProject]) assert.throws(() => draft(f.store, p.id, [id]), code('TIME_ASSIGNED'));
  assert.throws(() => draft(f.store, p.id, [good, good]));
  assert.deepEqual(f.store.state(), before);
  assert.equal(before.insights.find(i => i.projectId === p.id)!.workedMinutes, 120);
  assert.equal(before.insights.find(i => i.projectId === p.id)!.unbilledMinutes, 60);
});

test('draft reservation prevents double allocation and deletion releases the time', t => {
  const f = fixture(t), p = project(f.store), timeId = time(f.store, p.id);
  const invoiceId = draft(f.store, p.id, [timeId]);
  assert.throws(() => draft(f.store, p.id, [timeId]), code('TIME_ASSIGNED'));
  assert.throws(() => execute(f.store, { type: 'time.delete', data: { id: timeId, revision: 1 } }), code('LOCKED'));
  assert.throws(() => execute(f.store, { type: 'time.update', data: { id: timeId, revision: 1, projectId: p.id, date: '2026-09-01', minutes: 90, description: 'Changed', category: 'Delivery', billable: true, approved: true } }), code('LOCKED'));
  execute(f.store, { type: 'invoice.deleteDraft', data: { id: invoiceId, revision: 1 } });
  assert.equal(f.store.state().timeEntries[0].invoiceId, null);
  assert.equal(f.store.state().insights[0].unbilledMinutes, 60);
  assert.ok(draft(f.store, p.id, [timeId]));
});

test('issuance snapshots data, allocates time and increases numbering atomically', t => {
  const f = fixture(t); business(f.store); const p = project(f.store), timeId = time(f.store, p.id);
  const invoiceId = draft(f.store, p.id, [timeId]), requestId = randomUUID();
  const command: Command = { type: 'invoice.issue', data: { id: invoiceId, revision: 1 } };
  const first = f.store.execute(command, requestId);
  assert.deepEqual(f.store.execute(command, requestId), first);
  const issued = f.store.state().invoices[0];
  assert.equal(issued.number, 'INV-2026-0001');
  assert.equal(issued.totalMinor, 12_100);
  assert.equal(issued.status, 'issued');
  assert.equal(f.store.state().business.nextInvoiceNumber, 2);
  assert.equal(f.store.state().timeEntries[0].invoiceId, issued.id);
  assert.throws(() => f.store.execute(command), code('REVISION_CONFLICT'));
  assert.throws(() => draft(f.store, p.id, [timeId]), code('TIME_ASSIGNED'));

  business(f.store, { name: 'Renamed Studio', address: 'New supplier address', defaultTaxRate: '9' });
  const oldClient = f.store.state().clients[0];
  execute(f.store, { type: 'client.update', data: { ...oldClient, name: 'Renamed Client', address: 'New client address' } });
  const oldProject = f.store.state().projects[0];
  execute(f.store, { type: 'project.update', data: { ...p.input, id: p.id, revision: oldProject.revision, rate: '250.00' } });
  assert.deepEqual(f.store.state().invoices[0], issued);
  assert.equal(f.store.state().timeEntries[0].rateMinor, 10_000, 'Historical time preserves its agreed rate.');
  const nextTime = time(f.store, p.id);
  assert.equal(f.store.state().timeEntries.find(x => x.id === nextTime)!.rateMinor, 25_000);
  const nextDraft = draft(f.store, p.id, [nextTime]);
  assert.equal(issue(f.store, nextDraft).number, 'INV-2026-0002');
});

test('two connections see reservations and stale revisions rather than double invoices', t => {
  const f = fixture(t); business(f.store); const p = project(f.store), timeId = time(f.store, p.id);
  const second = new WorkspaceStore(f.path);
  try {
  const firstDraft = draft(f.store, p.id, [timeId]);
  assert.throws(() => draft(second, p.id, [timeId]), code('TIME_ASSIGNED'));
  const secondTime = time(second, p.id), secondDraft = draft(second, p.id, [secondTime]);
  assert.equal(issue(f.store, firstDraft).number, 'INV-2026-0001');
  assert.equal(issue(second, secondDraft).number, 'INV-2026-0002');
  assert.deepEqual(f.store.state(), second.state());
  const current = f.store.state().projects[0];
  execute(f.store, { type: 'project.update', data: { ...p.input, id: p.id, revision: current.revision, name: 'Updated in first tab' } });
  assert.throws(() => execute(second, { type: 'project.update', data: { ...p.input, id: p.id, revision: current.revision, name: 'Stale second tab' } }), code('REVISION_CONFLICT'));
  } finally { second.close(); }
});

test('unsupported settings or future dates leave drafts, time and numbering intact', t => {
  const f = fixture(t), p = project(f.store), timeId = time(f.store, p.id), invoiceId = draft(f.store, p.id, [timeId]);
  assert.ok(f.store.state().invoices[0].issueBlockers.length > 0);
  const before = f.store.state();
  assert.throws(() => issue(f.store, invoiceId), code('UNSUPPORTED_ISSUANCE'));
  assert.deepEqual(f.store.state(), before);
  business(f.store);
  execute(f.store, { type: 'invoice.deleteDraft', data: { id: invoiceId, revision: 1 } });
  const future = execute(f.store, { type: 'invoice.draft', data: { projectId: p.id, timeEntryIds: [timeId], issueDate: '2999-01-01', supplyDate: '2999-01-01', dueDate: '2999-02-01', taxRate: '21', notes: '', extraLines: [] } });
  assert.throws(() => issue(f.store, future), code('UNSUPPORTED_ISSUANCE'));
  assert.equal(f.store.state().business.nextInvoiceNumber, 1);
  assert.equal(f.store.state().invoices[0].status, 'draft');
});

test('partial payments, reversal and credit have separate revenue and balance effects', t => {
  const f = fixture(t); business(f.store); const p = project(f.store), invoiceId = draft(f.store, p.id, [time(f.store, p.id)]); issue(f.store, invoiceId);
  const paymentId = execute(f.store, { type: 'payment.create', data: { invoiceId, date: '2026-09-03', amount: '50.00', reference: 'Part payment' } });
  assert.equal(f.store.state().invoices[0].outstandingMinor, 7100);
  assert.equal(f.store.state().totals.revenueMinor, 10_000);
  execute(f.store, { type: 'credit.create', data: { invoiceId, date: '2026-09-04', netAmount: '20.00', reason: 'Scope correction' } });
  assert.equal(f.store.state().invoices[0].creditedMinor, 2420);
  assert.equal(f.store.state().invoices[0].outstandingMinor, 4680);
  assert.equal(f.store.state().totals.revenueMinor, 8000);
  const reversalId = execute(f.store, { type: 'payment.reverse', data: { id: paymentId, date: '2026-09-05', reason: 'Wrong payment record' } });
  assert.equal(f.store.state().payments.find(x => x.id === reversalId)!.amountMinor, -5000);
  assert.equal(f.store.state().invoices[0].paidMinor, 0);
  assert.equal(f.store.state().invoices[0].outstandingMinor, 9680);
  assert.equal(f.store.state().totals.revenueMinor, 8000);
  assert.throws(() => execute(f.store, { type: 'payment.reverse', data: { id: paymentId, date: '2026-09-05', reason: 'Again' } }), code('ALREADY_REVERSED'));
  assert.throws(() => execute(f.store, { type: 'payment.reverse', data: { id: reversalId, date: '2026-09-05', reason: 'Reverse reversal' } }), code('ALREADY_REVERSED'));
  const before = f.store.state();
  assert.throws(() => execute(f.store, { type: 'payment.create', data: { invoiceId, date: '2026-09-06', amount: '96.81', reference: 'Too much' } }));
  assert.deepEqual(f.store.state(), before);
});

test('full credit clears original line-rounded tax exactly even after partial credit', t => {
  const f = fixture(t); business(f.store); const p = project(f.store);
  const invoiceId = draft(f.store, p.id, [], [{ description: 'First tiny line', quantity: '1', unitPrice: '0.02', taxRate: '21' }, { description: 'Second tiny line', quantity: '1', unitPrice: '0.02', taxRate: '21' }, { description: 'Third tiny line', quantity: '1', unitPrice: '0.03', taxRate: '21' }]);
  const issued = issue(f.store, invoiceId);
  assert.equal(issued.taxMinor, 1);
  execute(f.store, { type: 'credit.create', data: { invoiceId, date: '2026-09-03', netAmount: '0.02', reason: 'Partial credit' } });
  execute(f.store, { type: 'credit.create', data: { invoiceId, date: '2026-09-04', netAmount: '0.05', reason: 'Final credit' } });
  assert.equal(f.store.state().invoices[0].outstandingMinor, 0);
  assert.equal(f.store.state().totals.revenueMinor, 0);
  assert.equal(f.store.state().creditNotes.reduce((total, c) => total + c.taxMinor, 0), issued.taxMinor);
  assert.throws(() => execute(f.store, { type: 'credit.create', data: { invoiceId, date: '2026-09-05', netAmount: '0.01', reason: 'Overcredit' } }));
});

test('a credit after full payment shows refund due instead of inventing another payment', t => {
  const f = fixture(t); business(f.store); const p = project(f.store), invoiceId = draft(f.store, p.id, [time(f.store, p.id)]); issue(f.store, invoiceId);
  execute(f.store, { type: 'payment.create', data: { invoiceId, date: '2026-09-03', amount: '121.00', reference: 'Full payment' } });
  execute(f.store, { type: 'credit.create', data: { invoiceId, date: '2026-09-04', netAmount: '10.00', reason: 'Credit after payment' } });
  assert.equal(f.store.state().invoices[0].outstandingMinor, -1210);
  assert.equal(f.store.state().payments.length, 1);
  assert.equal(f.store.state().totals.revenueMinor, 9000);
});

test('fixed project bills the contract once while all approved work measures contribution', t => {
  const f = fixture(t); business(f.store); const p = project(f.store, { kind: 'fixed', fixedPrice: '1000.00', status: 'active', estimatedRemainingMinutes: 600 });
  const delivery = time(f.store, p.id, { minutes: 600 }); time(f.store, p.id, { minutes: 300, billable: false, category: 'Aftercare' });
  assert.equal(f.store.state().insights[0].unbilledMinor, 0);
  assert.throws(() => draft(f.store, p.id, [delivery]));
  assert.throws(() => draft(f.store, p.id, [], [{ description: 'Extra', quantity: '1', unitPrice: '10', taxRate: '21' }]));
  const invoiceId = draft(f.store, p.id);
  assert.equal(f.store.state().invoices[0].lines.length, 1);
  assert.equal(f.store.state().invoices[0].netMinor, 100_000);
  assert.throws(() => draft(f.store, p.id), code('FIXED_ALREADY_INVOICED'));
  execute(f.store, { type: 'invoice.deleteDraft', data: { id: invoiceId, revision: 1 } });
  const issuedId = draft(f.store, p.id); issue(f.store, issuedId);
  assert.throws(() => draft(f.store, p.id), code('FIXED_ALREADY_INVOICED'));
  const insight = f.store.state().insights[0];
  assert.equal(insight.workedMinutes, 900);
  assert.equal(insight.contributionPerHourMinor, 6667);
  assert.equal(insight.contractedMinor, 100_000);
  assert.equal(insight.provisional, true);
  assert.throws(() => execute(f.store, { type: 'project.update', data: { ...p.input, id: p.id, revision: 1, fixedPrice: '2000.00' } }), code('LOCKED'));
});

test('unknown cost confirmation stays unknown; deductible tax and nonbillable work affect insight correctly', t => {
  const f = fixture(t); business(f.store); const p = project(f.store, { costsComplete: false });
  const invoiceId = draft(f.store, p.id, [time(f.store, p.id)]); issue(f.store, invoiceId);
  time(f.store, p.id, { minutes: 60, billable: false, category: 'Preparation' });
  time(f.store, p.id, { minutes: 60, approved: false, category: 'Other' });
  const expense = (deductibleTax: boolean) => execute(f.store, { type: 'expense.create', data: { projectId: p.id, date: '2026-09-01', description: 'Fictional direct cost', netAmount: '10', taxAmount: '2.10', deductibleTax, attachment: null } });
  expense(true); expense(false);
  let insight = f.store.state().insights[0];
  assert.equal(insight.directCostsMinor, 2210);
  assert.equal(insight.contributionMinor, null);
  assert.equal(insight.contributionPerHourMinor, null);
  assert.equal(insight.workedMinutes, 120);
  assert.equal(f.store.state().totals.nonBillableMinutes, 60);
  execute(f.store, { type: 'project.update', data: { ...p.input, id: p.id, revision: 1, costsComplete: true } });
  insight = f.store.state().insights[0];
  assert.equal(insight.contributionMinor, 7790);
  assert.equal(insight.contributionPerHourMinor, 3895);
});

test('invalid date, oversized money and invalid attachment roll back every related record', t => {
  const f = fixture(t), p = project(f.store); const before = f.store.state();
  assert.throws(() => time(f.store, p.id, { date: '2026-02-30' }));
  assert.throws(() => execute(f.store, { type: 'expense.create', data: { projectId: p.id, date: '2026-09-01', description: 'Overflow', netAmount: '1000000000.01', taxAmount: '0', deductibleTax: true, attachment: { name: 'fictional.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-test').toString('base64') } } }));
  assert.throws(() => execute(f.store, { type: 'expense.create', data: { projectId: p.id, date: '2026-09-01', description: 'Invalid attachment', netAmount: '10', taxAmount: '0', deductibleTax: true, attachment: { name: 'fictional.pdf', mime: 'application/pdf', base64: Buffer.from('Not a PDF').toString('base64') } } }));
  assert.deepEqual(f.store.state(), before);
});

test('aggregate monetary overflow is rejected before commit, preserving a readable workspace', t => {
  const f = fixture(t), p = project(f.store);
  execute(f.store, { type: 'expense.create', data: { projectId: p.id, date: '2026-09-01', description: 'Maximum supported total', netAmount: '1000000000.00', taxAmount: '0', deductibleTax: true, attachment: null } });
  assert.equal(f.store.state().totals.directCostsMinor, MAX_MONEY);
  const before = f.store.state();
  assert.throws(() => execute(f.store, { type: 'expense.create', data: { projectId: p.id, date: '2026-09-01', description: 'One cent too much', netAmount: '0.01', taxAmount: '0', deductibleTax: true, attachment: null } }));
  assert.deepEqual(f.store.state(), before);
});

test('currency cannot relabel existing amounts and active timer requires explicit duration review', t => {
  const f = fixture(t), p = project(f.store), before = f.store.state();
  assert.throws(() => business(f.store, { currency: 'USD' }), code('CURRENCY_LOCKED'));
  assert.deepEqual(f.store.state(), before);
  execute(f.store, { type: 'timer.start', data: { projectId: p.id, description: 'Meeting review', category: 'Meeting', billable: false } });
  assert.throws(() => execute(f.store, { type: 'timer.start', data: { projectId: p.id, description: 'Second timer', category: 'Delivery', billable: true } }), code('TIMER_ACTIVE'));
  f.reopen();
  execute(f.store, { type: 'timer.stop', data: { minutes: 15, date: '2026-09-01', approved: false } });
  const state = f.store.state();
  assert.equal(state.timer, null);
  assert.equal(state.timeEntries[0].minutes, 15);
  assert.equal(state.timeEntries[0].approved, false);
  assert.equal(state.timeEntries[0].billable, false);
  assert.equal(state.totals.workedMinutes, 0);
  assert.throws(() => execute(f.store, { type: 'timer.stop', data: { minutes: 15, date: '2026-09-01', approved: true } }), code('NO_TIMER'));
});

test('demo fixtures reproduce the promised project comparison without counting unrevised time', t => {
  const f = fixture(t); seedDemo(f.store);
  const state = f.store.state();
  const llamaProject = state.projects.find(p => p.name === 'The quiet launch')!;
  const hydraProject = state.projects.find(p => p.name === 'The meeting marathon')!;
  const llama = state.insights.find(i => i.projectId === llamaProject.id)!;
  const hydra = state.insights.find(i => i.projectId === hydraProject.id)!;
  assert.deepEqual([llama.revenueMinor, llama.directCostsMinor, llama.workedMinutes, llama.contributionPerHourMinor], [240_000, 30_000, 1200, 10_500]);
  assert.deepEqual([hydra.revenueMinor, hydra.directCostsMinor, hydra.workedMinutes, hydra.contributionPerHourMinor], [300_000, 50_000, 3000, 5000]);
  assert.equal(state.totals.revenueMinor, 540_000);
  assert.equal(state.totals.workedMinutes, 4200);
  assert.equal(state.totals.nonBillableMinutes, 1440);
  assert.equal(state.attachments.length, 2);
  assert.equal(state.timeEntries.filter(t => !t.approved).length, 1);
});

test('future time can remain an unapproved proposal but cannot become actual work', t => {
  const f = fixture(t), p = project(f.store);
  const before = f.store.state();
  assert.throws(() => time(f.store, p.id, { date: '2999-01-01', approved: true }));
  assert.deepEqual(f.store.state(), before);
  const proposal = time(f.store, p.id, { date: '2999-01-01', approved: false });
  assert.equal(f.store.state().totals.workedMinutes, 0);
  const unapprovedState = f.store.state();
  assert.throws(() => execute(f.store, { type: 'time.update', data: { id: proposal, revision: 1, projectId: p.id, date: '2999-01-01', minutes: 60, description: 'Future proposal', category: 'Delivery', billable: true, approved: true } }));
  assert.deepEqual(f.store.state(), unapprovedState);
  assert.throws(() => draft(f.store, p.id, [proposal]), code('TIME_ASSIGNED'));
});

test('future expenses, receipts, reversals and credits cannot alter actual financial records', t => {
  const f = fixture(t); business(f.store); const p = project(f.store), invoiceId = draft(f.store, p.id, [time(f.store, p.id)]); issue(f.store, invoiceId);
  const paymentId = execute(f.store, { type: 'payment.create', data: { invoiceId, date: '2026-09-03', amount: '50.00', reference: 'Actual receipt' } });
  const before = f.store.state();
  const invalid: Command[] = [
    { type: 'expense.create', data: { projectId: p.id, date: '2999-01-01', description: 'Future cost', netAmount: '10', taxAmount: '2.10', deductibleTax: true, attachment: null } },
    { type: 'payment.create', data: { invoiceId, date: '2999-01-01', amount: '10', reference: 'Future receipt' } },
    { type: 'payment.reverse', data: { id: paymentId, date: '2999-01-01', reason: 'Future reversal' } },
    { type: 'credit.create', data: { invoiceId, date: '2999-01-01', netAmount: '10', reason: 'Future credit' } },
  ];
  for (const command of invalid) {
    assert.throws(() => execute(f.store, command), command.type);
    assert.deepEqual(f.store.state(), before);
  }
});

test('workspace registry save failure preserves the previous active workspace', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'billable-manager-test-'));
  let manager = new WorkspaceManager(directory);
  t.after(() => { manager.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = structuredClone(manager.state());
  const registryPath = join(directory, 'workspaces.json');
  const originalRegistry = readFileSync(registryPath, 'utf8');
  // A directory occupying the staged filename deterministically simulates a failed registry write.
  mkdirSync(`${registryPath}.tmp`);
  const envelope = { requestId: randomUUID(), workspaceId: before.workspace.id, command: { type: 'workspace.create', data: { name: 'Failed new workspace', currency: 'EUR', demo: false } } } as const;
  await assert.rejects(manager.execute(envelope));
  assert.deepEqual(manager.state(), before);
  assert.equal(readFileSync(registryPath, 'utf8'), originalRegistry);
  rmSync(`${registryPath}.tmp`, { recursive: true });
  const recovered = await manager.execute(envelope);
  assert.equal(recovered.createdId, envelope.requestId);
  assert.equal(recovered.state.workspace.id, envelope.requestId);
  assert.equal(recovered.state.workspaces.length, before.workspaces.length + 1);
  manager.close();
  manager = new WorkspaceManager(directory);
  assert.equal(manager.state().workspace.id, envelope.requestId, 'Successful retry is durable across restart.');
  assert.ok(manager.state().workspaces.some(w => w.id === before.workspace.id), 'The previous workspace remains available.');
});

test('retrying completed workspace creation does not undo another tab workspace change', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'billable-manager-test-'));
  const manager = new WorkspaceManager(directory);
  t.after(() => { manager.close(); rmSync(directory, { recursive: true, force: true }); });
  const sourceId = manager.state().workspace.id;
  const first = { requestId: randomUUID(), workspaceId: sourceId, command: { type: 'workspace.create', data: { name: 'First workspace', currency: 'EUR', demo: false } } } as const;
  await manager.execute(first);
  const second = { requestId: randomUUID(), workspaceId: first.requestId, command: { type: 'workspace.create', data: { name: 'Another tab workspace', currency: 'EUR', demo: false } } } as const;
  await manager.execute(second);
  try { await manager.execute(first); } catch (error) { assert.ok(code('WORKSPACE_CHANGED')(error)); }
  assert.equal(manager.state().workspace.id, second.requestId);
  assert.equal(manager.state().workspaces.length, 3);
});

test('credit-note namespace cannot be selected as an invoice prefix', t => {
  const f = fixture(t), before = f.store.state();
  for (const invoicePrefix of ['CN', 'cn', 'Cn']) {
    assert.throws(() => business(f.store, { invoicePrefix }));
    assert.deepEqual(f.store.state(), before);
  }
});

test('invoice sequence exhaustion rolls back issue and preserves the time reservation', t => {
  const f = fixture(t); business(f.store, { nextInvoiceNumber: 999_999_998 }); const p = project(f.store);
  const first = draft(f.store, p.id, [time(f.store, p.id)]);
  assert.equal(issue(f.store, first).number, 'INV-2026-999999998');
  assert.equal(f.store.state().business.nextInvoiceNumber, 999_999_999);
  const timeId = time(f.store, p.id), blocked = draft(f.store, p.id, [timeId]), before = f.store.state();
  assert.throws(() => issue(f.store, blocked), code('SEQUENCE_EXHAUSTED'));
  assert.deepEqual(f.store.state(), before);
  assert.equal(f.store.state().timeEntries.find(x => x.id === timeId)!.invoiceId, blocked);
  assert.equal(f.store.state().invoices.find(x => x.id === blocked)!.status, 'draft');
});

test('time invoice snapshots preserve exact minutes independently of rounded hour display', t => {
  const f = fixture(t), p = project(f.store, { rate: '15000.00' });
  const id = draft(f.store, p.id, [time(f.store, p.id, { minutes: 1 })]);
  const line = f.store.state().invoices.find(i => i.id === id)!.lines[0];
  assert.equal(line.timeMinutes, 1);
  assert.equal(line.quantity, '0.016667');
  assert.equal(line.unitPriceMinor, 1_500_000);
  assert.equal(line.netMinor, 25_000, 'Value comes from exact minutes, not rounded decimal-hour text.');
});

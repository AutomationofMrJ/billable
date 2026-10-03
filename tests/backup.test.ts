import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { createBackup, validateBackup } from '../server/backup.js';
import { WorkspaceStore } from '../server/store.js';
import type { BusinessProfile, Command, Workspace } from '../shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const receipt = Buffer.from('%PDF-1.4\nFictional receipt for an isolated test fixture.\n%%EOF');
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'billable-backup-test-'));
  const workspace: Workspace = { id: randomUUID(), name: 'Fictional test studio', demo: true, currency: 'EUR' };
  const path = join(directory, 'source.sqlite');
  const store = new WorkspaceStore(path, workspace);
  const exec = (command: Command) => store.execute(command).createdId!;
  const profile = store.setting<BusinessProfile>('business');
  exec({type:'business.update',data:{...profile,name:'Fictional Pine Studio',address:'1 Example Lane\nAmsterdam',legalForm:'Sole proprietor',taxRegistered:true,taxId:'NL000000000B00',registrationId:'00000000',logo:{name:'studio.png',mime:'image/png',base64:png.toString('base64')}}});
  const client = exec({type:'client.create',data:{name:'Fictional Client',address:'Long fictional address\n8 Example Road\nAmsterdam',country:'NL',email:'',taxId:''}});
  const project = exec({type:'project.create',data:{clientId:client,name:'=Spreadsheet safe project',kind:'hourly',rate:'150.00',fixedPrice:null,costsComplete:true,status:'complete',estimatedRemainingMinutes:0}});
  const time = exec({type:'time.create',data:{projectId:project,date:'2026-01-01',minutes:61,description:'Design, review "and" delivery\nTwo lines',category:'Delivery',billable:true,approved:true}});
  exec({type:'time.create',data:{projectId:project,date:'2026-01-01',minutes:20,description:'Unpaid aftercare',category:'Aftercare',billable:false,approved:true}});
  const invoice = exec({type:'invoice.draft',data:{projectId:project,timeEntryIds:[time],issueDate:'2026-01-02',supplyDate:'2026-01-01',dueDate:'2026-01-31',taxRate:'21',notes:'Fictional fixture',extraLines:[]}});
  exec({type:'invoice.issue',data:{id:invoice,revision:1}});
  exec({type:'payment.create',data:{invoiceId:invoice,date:'2026-01-10',amount:'50.00',reference:'Fictional part payment'}});
  exec({type:'credit.create',data:{invoiceId:invoice,date:'2026-01-11',netAmount:'10.00',reason:'Fictional correction'}});
  exec({type:'expense.create',data:{projectId:project,date:'2026-01-01',description:'Fictional print production',netAmount:'20.00',taxAmount:'4.20',deductibleTax:false,attachment:{name:'original receipt.pdf',mime:'application/pdf',base64:receipt.toString('base64')}}});
  // Removing the current logo must not discard the issued invoice's original logo.
  exec({type:'business.update',data:{...store.setting<BusinessProfile>('business'),logo:null}});
  return { directory, store, workspace, path, project, invoice, close: async () => { if (store.db.open) store.close(); await rm(directory, {recursive:true,force:true}); } };
}
function rehash(zip: AdmZip): Buffer {
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  manifest.files = Object.fromEntries(zip.getEntries().filter(entry => entry.entryName !== 'manifest.json').map(entry => {
    const bytes = entry.getData(); return [entry.entryName, {size:bytes.length,sha256:hash(bytes)}];
  }));
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return zip.toBuffer();
}

test('consistent backup round-trips all records, invoice totals, logo and receipt into an empty directory', async () => {
  const f = await fixture();
  try {
    const original = f.store.state();
    const backup = await createBackup(f.store.db);
    const zip = new AdmZip(backup);
    const validated = await validateBackup(backup);
    assert.deepEqual(validated.workspace, f.workspace);
    const target = join(f.directory, 'restored.sqlite'); await writeFile(target, validated.database);
    const restored = new WorkspaceStore(target);
    try {
      const actual = restored.state();
      assert.deepEqual(actual, original);
      assert.equal(actual.attachments.length, 2);
      for (const attachment of actual.attachments) {
        assert.equal(hash(restored.attachmentBytes(attachment.id).bytes), attachment.sha256);
        assert.deepEqual(zip.readFile(`attachments/${attachment.id}`), restored.attachmentBytes(attachment.id).bytes);
      }
      assert.match(zip.readAsText('time.csv'), /'=Spreadsheet safe project/);
      assert.match(zip.readAsText('time.csv'), /review ""and"" delivery\nTwo lines/);
      assert.equal(actual.invoices[0].outstandingMinor, 12_243);
    } finally { restored.close(); }
  } finally { await f.close(); }
});

test('backup remains readable after the source process/store closes and reopens', async () => {
  const f = await fixture();
  try {
    const before = f.store.state(); const backup = await createBackup(f.store.db); f.store.close();
    const reopened = new WorkspaceStore(f.path);
    try { assert.deepEqual(reopened.state(), before); } finally { reopened.close(); }
    assert.deepEqual((await validateBackup(backup)).workspace, f.workspace);
  } finally { await f.close(); }
});

test('corrupt file hashes, missing entries and unsupported versions leave the original administration untouched', async () => {
  const f = await fixture();
  try {
    const before = f.store.state(); const backup = await createBackup(f.store.db);
    const corrupt = new AdmZip(backup); corrupt.updateFile('records.json', Buffer.from('{}'));
    await assert.rejects(validateBackup(corrupt.toBuffer()), /hash\/size/);
    const missing = new AdmZip(backup); missing.deleteFile('time.csv');
    await assert.rejects(validateBackup(rehash(missing)), /exports are missing|number of entries/);
    const newer = new AdmZip(backup); const manifest = JSON.parse(newer.readAsText('manifest.json')); manifest.version = 99; newer.updateFile('manifest.json',Buffer.from(JSON.stringify(manifest)));
    await assert.rejects(validateBackup(newer.toBuffer()), /Unsupported backup/);
    assert.deepEqual(f.store.state(), before);
  } finally { await f.close(); }
});

test('rejects traversal, unknown entries, excessive entry counts and oversized expansion metadata', async () => {
  const f = await fixture();
  try {
    const backup = await createBackup(f.store.db);
    const traversal = new AdmZip(backup); traversal.addFile('../outside.sqlite', Buffer.from('unsafe'));
    await assert.rejects(validateBackup(traversal.toBuffer()), /unsafe paths/);
    const extra = new AdmZip(backup); extra.addFile('secrets.env', Buffer.from('untrusted'));
    await assert.rejects(validateBackup(extra.toBuffer()), /unsafe paths/);
    const duplicate = Buffer.from(backup); const names = new AdmZip(backup).getEntries().filter(entry=>entry.entryName.startsWith('attachments/')).map(entry=>entry.entryName);
    assert.equal(names.length,2);
    const oldName=Buffer.from(names[1]); const newName=Buffer.from(names[0]);
    for(let offset=duplicate.indexOf(oldName);offset>=0;offset=duplicate.indexOf(oldName,offset+oldName.length))newName.copy(duplicate,offset);
    await assert.rejects(validateBackup(duplicate), /duplicate/i);
    const crowded = new AdmZip(backup); for (let index=0;index<1200;index++) crowded.addFile(`attachments/${randomUUID()}`,Buffer.alloc(0));
    await assert.rejects(validateBackup(crowded.toBuffer()), /number of entries/);
    // Alter a central-directory uncompressed-size declaration without allocating that size.
    const oversized = Buffer.from(backup); let offset = oversized.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    assert.ok(offset >= 0); oversized.writeUInt32LE(129 * 1024 * 1024, offset + 24);
    await assert.rejects(validateBackup(oversized), /integer range|supported limit/);
    const inconsistent=Buffer.from(backup);const local=inconsistent.indexOf(Buffer.from([0x50,0x4b,0x03,0x04]));
    inconsistent[local+30]^=1;
    await assert.rejects(validateBackup(inconsistent),/local and directory headers differ/);
  } finally { await f.close(); }
});

test('rejects an imported SQL trigger even when the attacker recomputes every payload hash', async () => {
  const f = await fixture();
  try {
    const zip = new AdmZip(await createBackup(f.store.db)); const path = join(f.directory, 'malicious.sqlite');
    await writeFile(path, zip.readFile('database.sqlite')!);
    const malicious = new Database(path);
    try { malicious.exec("CREATE TRIGGER untrusted_side_effect AFTER INSERT ON clients BEGIN SELECT 1; END"); } finally { malicious.close(); }
    zip.updateFile('database.sqlite', await readFile(path));
    await assert.rejects(validateBackup(rehash(zip)), /schema differs/);
  } finally { await f.close(); }
});

test('rejects independent JSON/CSV tampering even after ZIP hashes are recomputed', async () => {
  const f = await fixture();
  try {
    const zip = new AdmZip(await createBackup(f.store.db)); zip.updateFile('time.csv', Buffer.from('made-up financial data\n'));
    await assert.rejects(validateBackup(rehash(zip)), /exports differ/);
  } finally { await f.close(); }
});

test('refuses a backup of invalid money and mismatched original attachment bytes', async () => {
  const f = await fixture();
  try {
    const row = f.store.db.prepare('SELECT id,data FROM expenses LIMIT 1').get() as {id:string;data:string};
    const data = JSON.parse(row.data); data.costMinor += 1;
    f.store.db.prepare('UPDATE expenses SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
    await assert.rejects(createBackup(f.store.db), /Direct cost/);
    data.costMinor -= 1; f.store.db.prepare('UPDATE expenses SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
    f.store.db.prepare('UPDATE attachments SET sha256=? WHERE mime=?').run('0'.repeat(64),'application/pdf');
    await assert.rejects(createBackup(f.store.db), /bytes differ/);
  } finally { await f.close(); }
});

test('negative credit balances represent refunds due and survive backup without becoming new revenue', async () => {
  const f = await fixture();
  try {
    const invoice = f.store.state().invoices[0];
    f.store.execute({type:'payment.create',data:{invoiceId:invoice.id,date:'2026-01-12',amount:(invoice.outstandingMinor/100).toFixed(2),reference:'Remaining payment'}});
    f.store.execute({type:'credit.create',data:{invoiceId:invoice.id,date:'2026-01-13',netAmount:'5.00',reason:'Refund due'}});
    assert.equal(f.store.state().invoices[0].outstandingMinor, -605);
    await validateBackup(await createBackup(f.store.db));
  } finally { await f.close(); }
});

test('one minute at a high rate preserves exact integer minutes rather than rounding the displayed decimal hours', async () => {
  const f=await fixture();
  try {
    const clientId=f.store.state().clients[0].id;
    const projectId=f.store.execute({type:'project.create',data:{clientId,name:'Fictional rounding boundary',kind:'hourly',rate:'999999999.99',fixedPrice:null,costsComplete:true,status:'active',estimatedRemainingMinutes:null}}).createdId!;
    const timeId=f.store.execute({type:'time.create',data:{projectId,date:'2026-01-01',minutes:1,description:'One confirmed human minute',category:'Delivery',billable:true,approved:true}}).createdId!;
    const invoiceId=f.store.execute({type:'invoice.draft',data:{projectId,timeEntryIds:[timeId],issueDate:'2026-01-02',supplyDate:'2026-01-01',dueDate:'2026-01-31',taxRate:'21',notes:'',extraLines:[]}}).createdId!;
    const invoice=f.store.state().invoices.find(item=>item.id===invoiceId)!;
    assert.equal(invoice.lines[0].timeMinutes,1);assert.equal(invoice.lines[0].quantity,'0.016667');assert.equal(invoice.lines[0].netMinor,1_666_666_667);
    await validateBackup(await createBackup(f.store.db));
  }finally{await f.close();}
});

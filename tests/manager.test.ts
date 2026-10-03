import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../server/manager.js';
import { createBackup } from '../server/backup.js';
import type { Command, CommandEnvelope } from '../shared/types.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'billable-manager-test-'));
  const manager = new WorkspaceManager(root);
  const command = (value: Command, requestId = randomUUID(), workspaceId = manager.state().workspace.id): CommandEnvelope => ({requestId,workspaceId,command:value});
  return {root,manager,command,close:async()=>{manager.close();await rm(root,{recursive:true,force:true});}};
}

test('real workspaces start empty, demo data is isolated and the active workspace survives a restart', async () => {
  const f = await fixture();
  try {
    const demo = f.manager.state(); assert.equal(demo.workspace.demo,true); assert.equal(demo.projects.length,2);
    const created = await f.manager.execute(f.command({type:'workspace.create',data:{name:'Fictional empty administration',currency:'EUR',demo:false}}));
    assert.equal(created.state.workspace.demo,false); assert.equal(created.state.clients.length,0); assert.equal(created.state.invoices.length,0); assert.equal(created.state.attachments.length,0);
    await f.manager.execute(f.command({type:'client.create',data:{name:'Fictional Real-Mode Customer',address:'',country:'NL',email:'',taxId:''}}));
    const actual = f.manager.state(); f.manager.close();
    const restarted = new WorkspaceManager(f.root);
    try {
      assert.deepEqual(restarted.state(),actual);
      await restarted.execute({requestId:randomUUID(),workspaceId:actual.workspace.id,command:{type:'workspace.switch',data:{id:demo.workspace.id}}});
      assert.deepEqual(restarted.state().clients,demo.clients);
      assert.equal(restarted.state().clients.some(client=>client.name==='Fictional Real-Mode Customer'),false);
    } finally { restarted.close(); }
  } finally { await f.close(); }
});

test('restore validates first, assigns a new identity, preserves the original and clears a stale timer', async () => {
  const f = await fixture();
  try {
    const project = f.manager.state().projects[0];
    await f.manager.execute(f.command({type:'time.create',data:{projectId:project.id,date:'2099-01-01',minutes:30,description:'Future time proposal, not approved work',category:'Preparation',billable:true,approved:false}}));
    await f.manager.execute(f.command({type:'timer.start',data:{projectId:project.id,description:'Fictional review',category:'Meeting',billable:false}}));
    const before = f.manager.state(); const backup = await createBackup(f.manager.store.db);
    const created = await f.manager.execute(f.command({type:'backup.restore',data:{name:'Restored fictional studio',base64:backup.toString('base64')}}));
    assert.notEqual(created.state.workspace.id,before.workspace.id); assert.equal(created.state.workspace.demo,true);
    assert.equal(created.state.timer,null); assert.equal(created.state.workspaces.length,2);
    assert.deepEqual(created.state.invoices,before.invoices); assert.deepEqual(created.state.timeEntries,before.timeEntries);
    assert.ok(created.state.timeEntries.some(time=>time.date==='2099-01-01'&&!time.approved));
    assert.deepEqual(created.state.attachments,before.attachments); assert.deepEqual(created.state.totals,before.totals);
    for (const attachment of before.attachments) assert.equal(f.manager.store.attachmentBytes(attachment.id).sha256,attachment.sha256);
    // A second backup of a restored workspace includes optional operation metadata.
    await createBackup(f.manager.store.db);
    await f.manager.execute(f.command({type:'workspace.switch',data:{id:before.workspace.id}}));
    assert.deepEqual(f.manager.state().timer,before.timer); assert.deepEqual(f.manager.state().invoices,before.invoices);
  } finally { await f.close(); }
});

test('corrupt restore leaves active data and the workspace registry unchanged', async () => {
  const f = await fixture();
  try {
    const before = f.manager.state(); const registry = await readFile(join(f.root,'workspaces.json'),'utf8');
    await assert.rejects(f.manager.execute(f.command({type:'backup.restore',data:{name:'Bad import',base64:Buffer.from('invalid ZIP').toString('base64')}})),{code:'INVALID_BACKUP'});
    assert.deepEqual(f.manager.state(),before); assert.equal(await readFile(join(f.root,'workspaces.json'),'utf8'),registry);
  } finally { await f.close(); }
});

test('stale tabs cannot mutate another workspace and workspace creation retries retain one identity', async () => {
  const f = await fixture();
  try {
    const old = f.manager.state().workspace.id;
    const request = f.command({type:'workspace.create',data:{name:'Fictional second workspace',currency:'GBP',demo:false}});
    const first = await f.manager.execute(request); const retry = await f.manager.execute(request);
    assert.equal(first.createdId,retry.createdId); assert.equal(retry.state.workspaces.length,2);
    await assert.rejects(f.manager.execute(f.command({type:'client.create',data:{name:'Should not save',address:'',country:'GB',email:'',taxId:''}},randomUUID(),old)),{code:'WORKSPACE_CHANGED'});
    await assert.rejects(f.manager.execute({...request,command:{type:'workspace.create',data:{name:'Different meaning',currency:'GBP',demo:false}}}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.equal(f.manager.state().clients.length,0);
  } finally { await f.close(); }
});

test('failed registry save while creating preserves the active store and a retry recovers the completed new database', async () => {
  const f = await fixture();
  try {
    const before = f.manager.state(); const diskBefore = await readFile(join(f.root,'workspaces.json'),'utf8');
    const request = f.command({type:'workspace.create',data:{name:'Fictional recovery',currency:'EUR',demo:false}});
    const injectable = f.manager as unknown as {save:(...args:unknown[])=>void}; const save = injectable.save;
    injectable.save = () => {throw new Error('Fictional disk failure');};
    try { await assert.rejects(f.manager.execute(request),/Fictional disk failure/); } finally { injectable.save=save; }
    assert.deepEqual(f.manager.state(),before); assert.equal(await readFile(join(f.root,'workspaces.json'),'utf8'),diskBefore);
    const recovered = await f.manager.execute(request); assert.equal(recovered.createdId,request.requestId); assert.equal(recovered.state.workspaces.length,2);
    assert.equal((await f.manager.execute(request)).state.workspaces.length,2);
  } finally { await f.close(); }
});

test('failed registry save while switching preserves the current workspace and a retry can switch safely', async () => {
  const f = await fixture();
  try {
    const demo = f.manager.state().workspace;
    await f.manager.execute(f.command({type:'workspace.create',data:{name:'Fictional empty studio',currency:'EUR',demo:false}}));
    const before=f.manager.state(); const diskBefore=await readFile(join(f.root,'workspaces.json'),'utf8');
    const request=f.command({type:'workspace.switch',data:{id:demo.id}});
    const injectable=f.manager as unknown as {save:(...args:unknown[])=>void}; const save=injectable.save;
    injectable.save=()=>{throw new Error('Fictional switch disk failure');};
    try{await assert.rejects(f.manager.execute(request),/Fictional switch disk failure/);}finally{injectable.save=save;}
    assert.deepEqual(f.manager.state(),before);assert.equal(await readFile(join(f.root,'workspaces.json'),'utf8'),diskBefore);
    const switched=await f.manager.execute(request);assert.equal(switched.state.workspace.id,demo.id);assert.equal(switched.state.projects.length,2);
  }finally{await f.close();}
});

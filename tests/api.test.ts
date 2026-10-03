import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { AppState, Command, CommandResult } from '../shared/types';

test('real server restart, local security, duplicate concurrent issuance and restore through the API', {timeout:150_000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'billable-api-'));const port=14318;const base=`http://127.0.0.1:${port}`;let child:ChildProcess|undefined;let output='';
  async function start(){output='';child=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:resolve('.'),env:{...process.env,BILLABLE_DATA_DIR:root,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout?.on('data',b=>{output+=b.toString();});child.stderr?.on('data',b=>{output+=b.toString();});const start=Date.now();while(Date.now()-start<60_000){if(child.exitCode!==null)throw new Error(output);try{const r=await fetch(`${base}/api/state`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error(`Server startup timed out: ${output}`);}
  async function stop(){if(child&&child.exitCode===null){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill();await exited;}child=undefined;}
  try{
    await start();const state=await(await fetch(`${base}/api/state`)).json() as AppState;assert.equal(state.workspace.demo,true);assert.equal(state.insights.length,2);
    let token=(await(await fetch(`${base}/api/session`)).json()).token;
    const command=async(c:Command,workspaceId:string,requestId=randomUUID()):Promise<CommandResult>=>{const r=await fetch(`${base}/api/command`,{method:'POST',headers:{'Content-Type':'application/json','X-Billable-Token':token},body:JSON.stringify({requestId,workspaceId,command:c})});assert.equal(r.status,200,await r.clone().text());return r.json();};
    const denied=await fetch(`${base}/api/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
    assert.equal((await fetch(`${base}/api/state`,{headers:{Origin:'https://malicious.example'}})).status,403);
    // fetch() silently drops a custom Host header, so spoof it through node:http.
    const spoofedHost=await new Promise<number>((done,fail)=>{request({host:'127.0.0.1',port,path:'/api/state',headers:{Host:'malicious.example'}},r=>{r.resume();done(r.statusCode??0);}).on('error',fail).end();});
    assert.equal(spoofedHost,403);
    const created=await command({type:'workspace.create',data:{name:'API test studio',currency:'EUR',demo:false}},state.workspace.id);const w=created.state.workspace.id;assert.equal(created.state.clients.length,0);
    const b=created.state.business;await command({type:'business.update',data:{...b,name:'Fictional API Studio',address:'1 Test Street Amsterdam',legalForm:'Sole proprietor',taxRegistered:true,taxId:'NL000000000B00',registrationId:'00000000'}},w);
    const client=(await command({type:'client.create',data:{name:'API customer',address:'2 Sample Street Amsterdam',country:'NL',email:'',taxId:''}},w)).createdId!;
    const p=(await command({type:'project.create',data:{clientId:client,name:'API work',kind:'hourly',rate:'150.00',fixedPrice:null,costsComplete:true,status:'complete',estimatedRemainingMinutes:0}},w)).createdId!;
    const t=(await command({type:'time.create',data:{projectId:p,date:'2026-09-30',minutes:60,description:'Confirmed delivery',category:'Delivery',billable:true,approved:true}},w)).createdId!;
    const draft=(await command({type:'invoice.draft',data:{projectId:p,timeEntryIds:[t],issueDate:'2026-09-30',supplyDate:'2026-09-30',dueDate:'2026-10-30',taxRate:'21',notes:'',extraLines:[]}},w)).createdId!;
    const req=randomUUID();const results=await Promise.all([command({type:'invoice.issue',data:{id:draft,revision:1}},w,req),command({type:'invoice.issue',data:{id:draft,revision:1}},w,req)]);assert.equal(results[0].state.invoices[0].number,results[1].state.invoices[0].number);assert.equal(results[1].state.business.nextInvoiceNumber,2);
    const backup=Buffer.from(await(await fetch(`${base}/api/backup`)).arrayBuffer());assert.equal(backup.subarray(0,2).toString(),'PK');
    await stop();await start();const persisted=await(await fetch(`${base}/api/state`)).json() as AppState;assert.equal(persisted.workspace.id,w);assert.equal(persisted.invoices[0].number,'INV-2026-0001');assert.equal(persisted.timeEntries[0].invoiceId,draft);
    token=(await(await fetch(`${base}/api/session`)).json()).token;
    const bad=await fetch(`${base}/api/command`,{method:'POST',headers:{'Content-Type':'application/json','X-Billable-Token':token},body:JSON.stringify({workspaceId:w,requestId:randomUUID(),command:{type:'backup.restore',data:{name:'Bad import',base64:Buffer.from('not a backup').toString('base64')}}})});assert.equal(bad.status,400);assert.equal((await(await fetch(`${base}/api/state`)).json()).workspace.id,w);
    const restored=await command({type:'backup.restore',data:{name:'Restored API studio',base64:backup.toString('base64')}},w);assert.notEqual(restored.state.workspace.id,w);assert.equal(restored.state.invoices[0].totalMinor,18150);assert.equal(restored.state.workspaces.length,3);
  }finally{await stop();await rm(root,{recursive:true,force:true});}
});

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { WorkspaceStore, seedDemo } from './store';
import { validateBackup } from './backup';
import { AppError } from './validation';
import type { Workspace, CommandEnvelope, CommandResult } from '../shared/types';
interface Registry { activeId:string; workspaces:Workspace[]; }
export class WorkspaceManager {
  registry:Registry; store:WorkspaceStore; private lockPath:string; private released=false;
  constructor(public root:string) {
    mkdirSync(root,{recursive:true});this.lockPath=join(root,'server.lock');
    if(existsSync(this.lockPath)) {let pid=0;try{pid=JSON.parse(readFileSync(this.lockPath,'utf8')).pid;process.kill(pid,0);throw new AppError('Another Billable server is using this data folder.',409,'SERVER_ACTIVE');}catch(e){if(e instanceof AppError)throw e;if((e as NodeJS.ErrnoException).code!=='ESRCH'&&pid>0)throw new AppError('Could not verify the previous server lock. Close the other server first.',409,'SERVER_ACTIVE');unlinkSync(this.lockPath);}}
    const lock=openSync(this.lockPath,'wx');writeFileSync(lock,JSON.stringify({pid:process.pid}));closeSync(lock);
    try{
      if(existsSync(join(root,'workspaces.json')))this.registry=JSON.parse(readFileSync(join(root,'workspaces.json'),'utf8'));
      else {const workspace={id:randomUUID(),name:'The sample studio',demo:true,currency:'EUR'};this.registry={activeId:workspace.id,workspaces:[workspace]};const s=new WorkspaceStore(this.dbPath(workspace.id),workspace);try{s.db.transaction(()=>seedDemo(s))();}finally{s.close();}this.save();}
      if(!this.registry.workspaces.some(w=>w.id===this.registry.activeId))throw new Error('Workspace registry is invalid.');
      this.store=new WorkspaceStore(this.dbPath(this.registry.activeId));
    }catch(e){unlinkSync(this.lockPath);throw e;}
  }
  private dbPath(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new AppError('Invalid workspace ID.');return join(this.root,id,'workspace.sqlite');}
  private save(registry=this.registry){const path=join(this.root,'workspaces.json');writeFileSync(`${path}.tmp`,JSON.stringify(registry,null,2));renameSync(`${path}.tmp`,path);}
  state(){return this.store.state(this.registry.workspaces);}
  private activate(id:string){const w=this.registry.workspaces.find(w=>w.id===id);if(!w)throw new AppError('Workspace not found.',404,'NOT_FOUND');if(id!==this.registry.activeId){const next=new WorkspaceStore(this.dbPath(id));try{next.state();const proposed={...this.registry,activeId:id};this.save(proposed);this.store.close();this.store=next;this.registry=proposed;}catch(e){next.close();throw e;}}}
  async execute(e:CommandEnvelope):Promise<CommandResult>{
    const hash=createHash('sha256').update(JSON.stringify({workspaceId:e.workspaceId,command:e.command})).digest('hex');
    const cmd=e.command;
    if(cmd.type==='workspace.create'||cmd.type==='backup.restore'){
      const existing=this.registry.workspaces.find(w=>w.id===e.requestId);
      if(existing){const probe=new WorkspaceStore(this.dbPath(existing.id));let op: {hash:string}|undefined;try{op=probe.setting('operation');}finally{probe.close();}if(op?.hash!==hash)throw new AppError('Request ID is already in use.',409,'IDEMPOTENCY_CONFLICT');return {state:this.state(),createdId:existing.id,message:'This workspace operation already completed. The current workspace was preserved.'};}
      if(e.workspaceId!==this.registry.activeId)throw new AppError('Another tab switched the workspace. Refresh before making changes.',409,'WORKSPACE_CHANGED');
      let restored:Awaited<ReturnType<typeof validateBackup>>|null=null;
      if(cmd.type==='backup.restore'){try{restored=await validateBackup(Buffer.from(cmd.data.base64,'base64'));}catch(error){throw new AppError((error as Error).message,400,'INVALID_BACKUP');}}
      const workspace:Workspace={id:e.requestId,name:cmd.data.name,demo:cmd.type==='workspace.create'?cmd.data.demo:restored!.workspace.demo,currency:cmd.type==='workspace.create'?cmd.data.currency:restored!.workspace.currency};
      const path=this.dbPath(workspace.id);mkdirSync(join(this.root,workspace.id),{recursive:true});
      const recovery=existsSync(path);
      if(restored&&!recovery)writeFileSync(path,restored.database);
      const next=new WorkspaceStore(path,workspace);
      try{if(recovery){if(next.setting<{hash:string}>('operation')?.hash!==hash)throw new AppError('An incomplete operation with this ID cannot be recovered. Use a new request ID.',409,'INCOMPLETE_OPERATION');next.state();}else next.db.transaction(()=>{next.set('workspace',workspace);if(restored)next.set('timer',null);if(cmd.type==='workspace.create'&&cmd.data.demo)seedDemo(next);next.state();next.set('operation',{hash});})();const proposed={activeId:workspace.id,workspaces:[...this.registry.workspaces,workspace]};this.save(proposed);this.store.close();this.store=next;this.registry=proposed;}catch(err){next.close();throw err;}
      return {state:this.state(),createdId:workspace.id,message:restored?'Backup verified and restored into a new workspace.':'Workspace created.'};
    }
    if(e.workspaceId!==this.registry.activeId)throw new AppError('Another tab switched the workspace. Refresh before making changes.',409,'WORKSPACE_CHANGED');
    if(cmd.type==='workspace.switch'){this.activate(cmd.data.id);return {state:this.state()};}
    const result=this.store.execute(cmd,e.requestId);const w=this.store.setting<Workspace>('workspace');this.registry.workspaces=this.registry.workspaces.map(x=>x.id===w.id?w:x);this.save();return {state:this.state(),...result};
  }
  close(){if(this.released)return;this.released=true;this.store?.close();if(existsSync(this.lockPath))unlinkSync(this.lockPath);}
}

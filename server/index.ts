import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { WorkspaceManager } from './manager';
import { createBackup } from './backup';
import { AppError, envelopeSchema } from './validation';
const production=process.argv.includes('--production');
const port=Number(process.env.PORT??4318);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT must be an integer between 1024 and 65535.');
const appRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dataRoot=process.env.BILLABLE_DATA_DIR??join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'Billable','workspaces');
const manager=new WorkspaceManager(resolve(dataRoot));
const app=express();app.disable('x-powered-by');
const token=randomBytes(32).toString('hex'),allowedHost=`127.0.0.1:${port}`,origin=`http://${allowedHost}`;
let queue:Promise<unknown>=Promise.resolve();
function serial<T>(fn:()=>Promise<T>|T):Promise<T>{const result=queue.then(fn,fn);queue=result.catch(()=>undefined);return result;}
app.use((req,res,next)=>{
  if(req.headers.host!==allowedHost){res.status(403).json({error:'Use the local 127.0.0.1 address.',code:'HOST_REJECTED'});return;}
  if(req.headers.origin&&req.headers.origin!==origin){res.status(403).json({error:'Cross-site requests are not allowed.',code:'ORIGIN_REJECTED'});return;}
  if(req.headers['sec-fetch-site']==='cross-site'){res.status(403).json({error:'Cross-site requests are not allowed.',code:'ORIGIN_REJECTED'});return;}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',production?"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:*; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');next();
});
app.use('/api',express.json({limit:'190mb'}));
app.get('/api/session',(_req,res)=>res.json({token}));
app.get('/api/state',(_req,res)=>res.json(manager.state()));
app.post('/api/command',async(req,res,next)=>{try{const supplied=req.header('X-Billable-Token')??'';if(supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))throw new AppError('Local session expired. Reload the page.',403,'SESSION_REQUIRED');const e=envelopeSchema.parse(req.body);res.json(await serial(()=>manager.execute(e)));}catch(e){next(e);}});
app.get('/api/backup',async(_req,res,next)=>{try{const bytes=await serial(()=>createBackup(manager.store.db));res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="billable-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.zip"`);res.send(bytes);}catch(e){next(e);}});
app.get('/api/export',(_req,res)=>{res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition','attachment; filename="billable-analysis.json"');res.send(JSON.stringify({format:'billable-analysis',version:1,exportedAt:new Date().toISOString(),definitions:{revenue:'Issued net invoice amounts minus credit notes; payments are not revenue.',contribution:'Revenue minus recorded direct costs, only when costs have been confirmed complete; before overhead and personal tax.',hours:'Approved human work including non-billable preparation, meetings and aftercare.',scope:'Lifetime project totals; active projects provisional; contracts shown separately.'},state:manager.state()},null,2));});
app.get('/api/attachments/:id',(req,res,next)=>{try{const a=manager.store.attachmentBytes(req.params.id);res.setHeader('Content-Type',a.mime);res.setHeader('Content-Disposition',`${a.mime.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);res.send(a.bytes);}catch(e){next(e);}});
app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found.',code:'NOT_FOUND'}));
if(production){const dist=join(appRoot,'dist');if(!existsSync(join(dist,'index.html')))throw new Error('Run npm run build before npm start.');app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(join(dist,'index.html')));}
else{const {createServer}=await import('vite');const vite=await createServer({root:appRoot,server:{middlewareMode:true,hmr:{port:port+1,host:'127.0.0.1'}},appType:'spa'});app.use(vite.middlewares);}
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof ZodError){res.status(400).json({error:err.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '),code:'VALIDATION'});return;}
  if(err instanceof AppError){res.status(err.status).json({error:err.message,code:err.code});return;}
  if((err as {type?:string}).type==='entity.too.large'){res.status(413).json({error:'This upload is too large.',code:'SIZE_LIMIT'});return;}
  if(err instanceof RangeError||err instanceof TypeError){res.status(400).json({error:err.message,code:'VALIDATION'});return;}
  if((err as {code?:string}).code?.startsWith('SQLITE_CONSTRAINT')){res.status(409).json({error:'This operation conflicts with an existing record. Refresh and try again.',code:'CONFLICT'});return;}
  console.error(err instanceof Error?err.message:'Server error');res.status(500).json({error:'The operation could not be completed. Your workspace was preserved.',code:'SERVER_ERROR'});
});
const server=app.listen(port,'127.0.0.1',()=>console.log(`Billable ${production?'release':'development'}\n${origin}\nData folder: ${resolve(dataRoot)}\nPress Ctrl+C to stop.`));
server.on('error',e=>{manager.close();console.error(e.message);process.exitCode=1;});
let stopping=false;function stop(){if(stopping)return;stopping=true;server.close(()=>{manager.close();process.exit(0);});setTimeout(()=>{manager.close();process.exit(0);},3000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',()=>manager.close());

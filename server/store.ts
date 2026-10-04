import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Decimal from 'decimal.js';
import { migrate } from './schema';
import { AppError, commandSchema } from './validation';
import { money, tax, timeAmount, lineAmount, perHour, sumMoney, toBase, toDocument } from '../shared/money';
import { isEu, OTHER_COUNTRY } from '../shared/geo';
import type { AppState, Workspace, BusinessProfile, Client, Project, TimeEntry, Invoice, InvoiceLine, Expense, ExpenseInput, Payment, CreditNote, Attachment, Command, Upload, Timer, RecordMeta, TaxTreatment, VatFiling, VatFrequency, VatPeriod, VatRow, MonthSummary, YearSummary } from '../shared/types';

const j = (x:unknown) => JSON.stringify(x);
const meta = (): RecordMeta => ({id:randomUUID(),revision:1,createdAt:new Date().toISOString()});
export const localDate = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function defaultBusiness(currency='EUR'):BusinessProfile { return {name:'Your studio',address:'',country:'NL',region:'',legalForm:'',taxRegistered:false,taxId:'',registrationId:'',currency,invoicePrefix:'INV',nextInvoiceNumber:1,paymentInstructions:'',defaultTaxRate:'21',logoId:null,revision:1,vatFrequency:'quarterly',smallBusinessScheme:false}; }

/** Customer country decides the VAT path of a Netherlands supplier. */
export function taxTreatment(country:string):TaxTreatment { return country==='NL'?'domestic':country===OTHER_COUNTRY||!country?'unknown':isEu(country)?'eu-reverse-charge':'outside-eu'; }
/** Netherlands VAT return box for a sales line. Reverse charge and non-EU services carry no Dutch VAT. */
export function salesRubric(treatment:TaxTreatment, taxRate:string):string {
  if(treatment==='eu-reverse-charge')return '3b';
  if(treatment==='outside-eu')return 'outside';
  const rate=Number(taxRate);return rate===21?'1a':rate===9?'1b':rate===0?'1e':'1c';
}
const RUBRICS:[string,string][]=[['1a','Sales taxed at the standard rate (21%)'],['1b','Sales taxed at the reduced rate (9%)'],['1c','Sales taxed at other rates'],['1e','Sales taxed at 0% or not taxed with you'],['2a','Domestic reverse charge to you'],['3b','Services to businesses in other EU countries'],['4a','Services and goods from outside the EU'],['4b','Services and goods from other EU countries'],['outside','Services to customers outside the EU (check how to report)']];
const REVERSE=['reverse-domestic','import-non-eu','intra-eu'];
const EXPENSE_RUBRIC:Record<string,string>={'reverse-domestic':'2a','import-non-eu':'4a','intra-eu':'4b'};
export function vatPeriod(day:string,frequency:VatFrequency):string { return frequency==='monthly'?day.slice(0,7):frequency==='annual'?day.slice(0,4):`Q${Math.ceil(Number(day.slice(5,7))/3)} ${day.slice(0,4)}`; }
function periodRange(period:string):[string,string] {
  const last=(year:number,month:number)=>`${year}-${String(month).padStart(2,'0')}-${String(new Date(Date.UTC(year,month,0)).getUTCDate()).padStart(2,'0')}`;
  if(/^\d{4}$/.test(period))return [`${period}-01-01`,`${period}-12-31`];
  if(/^\d{4}-\d{2}$/.test(period))return [`${period}-01`,last(Number(period.slice(0,4)),Number(period.slice(5)))];
  const quarter=Number(period[1]),year=Number(period.slice(3));return [`${year}-${String(quarter*3-2).padStart(2,'0')}-01`,last(year,quarter*3)];
}

// Records written by earlier versions lack newer optional fields; reads always return the complete shape.
const normal:Record<string,(x:any)=>any>={
  clients:(c:any)=>({contactName:'',registrationId:'',notes:'',...c}),
  projects:(p:any)=>({notes:'',...p}),
  time_entries:(t:any)=>({startTime:null,endTime:null,notes:'',...t}),
  invoices:(i:any)=>({exchangeRate:'1',taxTreatment:taxTreatment(i.client?.country??''),baseNetMinor:i.netMinor,baseTaxMinor:i.taxMinor,baseTotalMinor:i.totalMinor,baseOutstandingMinor:i.totalMinor,...i,business:{vatFrequency:'quarterly',smallBusinessScheme:false,...i.business},client:{contactName:'',registrationId:'',notes:'',...i.client}}),
  credits:(c:any)=>({baseNetMinor:c.netMinor,baseTaxMinor:c.taxMinor,...c}),
  expenses:(e:any)=>({supplier:'',supplierInvoiceNumber:'',category:'',country:'',vatTreatment:'standard',paymentMethod:'',notes:'',reverseChargeTaxMinor:0,originalCurrency:'',originalAmountMinor:null,...e}),
};

/** Calendar-year totals of the monthly figures, newest year first. */
function years(months:MonthSummary[]):YearSummary[] {
  return [...new Set(months.map(m=>m.month.slice(0,4)))].sort().reverse().map(year=>{const list=months.filter(m=>m.month.startsWith(year));const revenueMinor=sumMoney(list.map(m=>m.revenueMinor)),costsMinor=sumMoney(list.map(m=>m.costsMinor));return {year,revenueMinor,costsMinor,resultMinor:sumMoney([revenueMinor,-costsMinor]),workedMinutes:list.reduce((a,m)=>a+m.workedMinutes,0),billableMinutes:list.reduce((a,m)=>a+m.billableMinutes,0)};});
}

export class WorkspaceStore {
  readonly db: Database.Database;
  constructor(public path:string, workspace?:Workspace) {
    mkdirSync(dirname(path),{recursive:true}); this.db=new Database(path); migrate(this.db);
    if (!this.setting<Workspace>('workspace')) {
      if (!workspace) throw new Error('Missing workspace metadata.');
      this.db.transaction(()=>{this.set('workspace',workspace);this.set('business',defaultBusiness(workspace.currency));this.set('timer',null);this.set('nextCredit',1);})();
    }
  }
  close(){ this.db.close(); }
  setting<T>(key:string):T {const row=this.db.prepare('SELECT data FROM settings WHERE key=?').get(key) as {data:string}|undefined;return (row?JSON.parse(row.data):undefined) as T;}
  set(key:string,value:unknown){this.db.prepare('INSERT INTO settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key,j(value));}
  business():BusinessProfile {return {vatFrequency:'quarterly',smallBusinessScheme:false,...this.setting<Partial<BusinessProfile>>('business')} as BusinessProfile;}
  list<T>(table:string):T[]{const n=normal[table]??(x=>x);return (this.db.prepare(`SELECT data FROM ${table}`).all() as {data:string}[]).map(x=>n(JSON.parse(x.data)));}
  get<T>(table:string,id:string):T {const row=this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data:string}|undefined;if(!row)throw new AppError('This record no longer exists.',404,'NOT_FOUND');return (normal[table]??(x=>x))(JSON.parse(row.data));}
  revise<T extends RecordMeta>(table:string,id:string,revision:number):T {const old=this.get<T>(table,id);if(old.revision!==revision)throw new AppError('This record changed in another tab. Refresh and try again.',409,'REVISION_CONFLICT');return old;}
  private locked(timeId:string){return Boolean(this.db.prepare('SELECT time_id FROM draft_times WHERE time_id=? UNION ALL SELECT time_id FROM allocations WHERE time_id=?').get(timeId,timeId));}
  private audit(type:string,id?:string){const m=meta();this.db.prepare('INSERT INTO audit_events VALUES(?,?)').run(m.id,j({...m,type,recordId:id??null}));}
  private attachment(upload:Upload):Attachment {
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(upload.base64)||upload.base64.length%4!==0)throw new AppError('The attachment encoding is invalid.');
    const bytes=Buffer.from(upload.base64,'base64'); if(bytes.toString('base64')!==upload.base64||bytes.length<1||bytes.length>5*1024*1024)throw new AppError('Attachments must be between 1 byte and 5 MB.',413,'SIZE_LIMIT');
    const valid=upload.mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):upload.mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,5).toString()==='%PDF-';
    if(!valid)throw new AppError('The file contents do not match PNG, JPEG or PDF.');
    const total=(this.db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM attachments').get() as {total:number}).total;
    if(total+bytes.length>50*1024*1024)throw new AppError('Workspace attachment limit is 50 MB.',413,'SIZE_LIMIT');
    const a={id:randomUUID(),name:upload.name,mime:upload.mime,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    this.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(a.id,a.name,a.mime,a.size,a.sha256,bytes);return a;
  }
  attachmentBytes(id:string){const r=this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id) as Attachment & {bytes:Buffer}|undefined;if(!r)throw new AppError('Attachment not found.',404,'NOT_FOUND');return r;}
  blockers(i:Invoice):string[] {
    const b=this.business(); const c=this.get<Client>('clients',i.clientId);const r:string[]=[];const treatment=taxTreatment(c.country);
    if(b.currency!=='EUR'||b.country!=='NL')r.push('Issuance currently supports Netherlands suppliers keeping their books in EUR.');
    if(!b.taxRegistered||b.smallBusinessScheme)r.push('A VAT registered supplier outside the small business scheme is required for this VAT path.');
    if(!b.name.trim()||!b.address.trim()||!b.legalForm.trim())r.push('Complete the supplier name, address and legal form in Settings.');
    if(!/^NL\d{9}B\d{2}$/.test(b.taxId))r.push('Enter a Netherlands VAT ID (NL, 9 digits, B, 2 digits).');
    if(!/^\d{8}$/.test(b.registrationId))r.push('Enter the supplier’s 8 digit KvK registration.');
    if(!c.name.trim()||!c.address.trim())r.push('Complete the customer name and address.');
    if(treatment==='unknown')r.push('Choose the customer country so the VAT treatment is known.');
    else if(treatment!==i.taxTreatment)r.push('The customer country changed after this draft was created. Delete the draft and create it again.');
    else if(treatment==='domestic'&&i.lines.some(x=>![21,9].includes(Number(x.taxRate))))r.push('Domestic lines must use the 21% or 9% Netherlands VAT rate.');
    else if(treatment==='eu-reverse-charge'&&i.lines.some(x=>Number(x.taxRate)!==0))r.push('EU business customers are reverse-charged: use 0% VAT on every line.');
    else if(treatment==='outside-eu'&&i.lines.some(x=>Number(x.taxRate)!==0))r.push('Services to customers outside the EU carry no Netherlands VAT: use 0% on every line.');
    if(treatment==='eu-reverse-charge'&&!c.taxId.trim())r.push('Enter the customer’s EU VAT ID for a reverse-charge invoice.');
    if(i.issueDate>localDate()||i.supplyDate>localDate()||i.lines.some(l=>l.timeEntryId&&this.get<TimeEntry>('time_entries',l.timeEntryId).date>localDate()))r.push('Future work and future invoice dates remain drafts.');
    if(i.netMinor<=0)r.push('The invoice must have a positive net amount.');return r;
  }
  private vat(business:BusinessProfile,invoices:Invoice[],creditNotes:CreditNote[],expenses:Expense[]):VatPeriod[] {
    const f=business.vatFrequency,filings=this.setting<Record<string,VatFiling>>('vatFilings')??{};
    const cells=new Map<string,Map<string,{net:number[];tax:number[]}>>();const input=new Map<string,number[]>();
    const cell=(period:string,code:string)=>{if(!cells.has(period))cells.set(period,new Map());const p=cells.get(period)!;if(!p.has(code))p.set(code,{net:[],tax:[]});return p.get(code)!;};
    for(const i of invoices.filter(i=>i.status==='issued')){
      const period=vatPeriod(i.issueDate,f),groups=new Map<string,InvoiceLine[]>();
      for(const l of i.lines){const code=salesRubric(i.taxTreatment,l.taxRate);groups.set(code,[...(groups.get(code)??[]),l]);}
      for(const [code,lines] of groups){const c=cell(period,code);c.net.push(toBase(sumMoney(lines.map(l=>l.netMinor)),i.exchangeRate));c.tax.push(toBase(sumMoney(lines.map(l=>l.taxMinor)),i.exchangeRate));}
    }
    for(const credit of creditNotes){const i=invoices.find(x=>x.id===credit.invoiceId);if(!i)continue;const c=cell(vatPeriod(credit.date,f),salesRubric(i.taxTreatment,i.lines[0].taxRate));c.net.push(-credit.baseNetMinor);c.tax.push(-credit.baseTaxMinor);}
    for(const e of expenses){
      const period=vatPeriod(e.date,f);cell(period,'1a');
      const code=EXPENSE_RUBRIC[e.vatTreatment];if(code){const c=cell(period,code);c.net.push(e.netMinor);c.tax.push(e.reverseChargeTaxMinor);}
      const reclaim=!e.deductibleTax||business.smallBusinessScheme?0:e.vatTreatment==='standard'?e.taxMinor:e.reverseChargeTaxMinor;
      input.set(period,[...(input.get(period)??[]),reclaim]);
    }
    cell(vatPeriod(localDate(),f),'1a');
    return [...cells.keys()].map(period=>{
      const p=cells.get(period)!;const rows:VatRow[]=RUBRICS.map(([code,label])=>({code,label,netMinor:sumMoney(p.get(code)?.net??[]),taxMinor:sumMoney(p.get(code)?.tax??[])}));
      const dueMinor=sumMoney(rows.filter(r=>['1a','1b','1c','2a','4a','4b'].includes(r.code)).map(r=>r.taxMinor)),inputMinor=sumMoney(input.get(period)??[]);const [start,end]=periodRange(period);
      return {period,start,end,rows,dueMinor,inputMinor,balanceMinor:sumMoney([dueMinor,-inputMinor]),filing:filings[period]??null};
    }).sort((a,b)=>b.start.localeCompare(a.start));
  }
  private months(invoices:Invoice[],creditNotes:CreditNote[],expenses:Expense[],timeEntries:TimeEntry[]):MonthSummary[] {
    const revenue=new Map<string,number[]>(),costs=new Map<string,number[]>(),worked=new Map<string,number>(),billable=new Map<string,number>();
    const push=(m:Map<string,number[]>,day:string,value:number)=>m.set(day.slice(0,7),[...(m.get(day.slice(0,7))??[]),value]);
    for(const i of invoices.filter(i=>i.status==='issued'))push(revenue,i.issueDate,i.baseNetMinor);
    for(const c of creditNotes)push(revenue,c.date,-c.baseNetMinor);
    for(const e of expenses)push(costs,e.date,e.costMinor);
    for(const t of timeEntries.filter(t=>t.approved)){const m=t.date.slice(0,7);worked.set(m,(worked.get(m)??0)+t.minutes);if(t.billable)billable.set(m,(billable.get(m)??0)+t.minutes);}
    const keys=[...revenue.keys(),...costs.keys(),...worked.keys()].sort();if(!keys.length)return [];
    // A continuous timeline from the first activity to this month (at most ten years) keeps empty months visible.
    const last=[keys[keys.length-1],localDate().slice(0,7)].sort()[1];const out:MonthSummary[]=[];let cumulative=0;
    for(let y=Number(keys[0].slice(0,4)),m=Number(keys[0].slice(5));out.length<120;m===12?(y++,m=1):m++){
      const month=`${y}-${String(m).padStart(2,'0')}`;if(month>last)break;
      const revenueMinor=sumMoney(revenue.get(month)??[]),costsMinor=sumMoney(costs.get(month)??[]),resultMinor=sumMoney([revenueMinor,-costsMinor]);cumulative=sumMoney([cumulative,resultMinor]);
      out.push({month,revenueMinor,costsMinor,resultMinor,cumulativeMinor:cumulative,workedMinutes:worked.get(month)??0,billableMinutes:billable.get(month)??0});
    }
    return out;
  }
  state(workspaces:Workspace[]=[]):AppState {
    const workspace=this.setting<Workspace>('workspace'),business=this.business();
    const clients=this.list<Client>('clients'),projects=this.list<Project>('projects'),payments=this.list<Payment>('payments'),creditNotes=this.list<CreditNote>('credits'),expenses=this.list<Expense>('expenses');
    const bindings=this.db.prepare('SELECT time_id,invoice_id FROM allocations UNION ALL SELECT time_id,invoice_id FROM draft_times').all() as {time_id:string;invoice_id:string}[];
    const assigned=new Map(bindings.map(x=>[x.time_id,x.invoice_id])); const timeEntries=this.list<TimeEntry>('time_entries').map(t=>({...t,invoiceId:assigned.get(t.id)??null}));
    const invoices=this.list<Invoice>('invoices').map(i=>{const paidMinor=sumMoney(payments.filter(p=>p.invoiceId===i.id).map(p=>p.amountMinor)),creditedMinor=sumMoney(creditNotes.filter(c=>c.invoiceId===i.id).map(c=>c.totalMinor)),outstandingMinor=sumMoney([i.totalMinor,-paidMinor,-creditedMinor]);return {...i,paidMinor,creditedMinor,outstandingMinor,baseOutstandingMinor:toBase(outstandingMinor,i.exchangeRate),issueBlockers:i.status==='draft'?this.blockers(i):[]};});
    const insights=projects.map(p=>{const times=timeEntries.filter(t=>t.projectId===p.id);const actual=times.filter(t=>t.approved);const revenueMinor=sumMoney(invoices.filter(i=>i.projectId===p.id&&i.status==='issued').map(i=>i.baseNetMinor).concat(creditNotes.filter(c=>invoices.some(i=>i.id===c.invoiceId&&i.projectId===p.id)).map(c=>-c.baseNetMinor)));const directCostsMinor=sumMoney(expenses.filter(e=>e.projectId===p.id).map(e=>e.costMinor));const workedMinutes=actual.reduce((a,t)=>a+t.minutes,0);const billableMinutes=actual.filter(t=>t.billable).reduce((a,t)=>a+t.minutes,0);const unbilled=actual.filter(t=>t.billable&&!t.invoiceId&&p.kind==='hourly');const contributionMinor=p.costsComplete?sumMoney([revenueMinor,-directCostsMinor]):null;return {projectId:p.id,revenueMinor,directCostsMinor,contributionMinor,contributionPerHourMinor:contributionMinor===null?null:perHour(contributionMinor,workedMinutes),workedMinutes,billableMinutes,unbilledMinutes:unbilled.reduce((a,t)=>a+t.minutes,0),unbilledMinor:sumMoney(unbilled.map(t=>timeAmount(t.minutes,t.rateMinor))),contractedMinor:p.fixedPriceMinor,provisional:!['complete','cancelled'].includes(p.status)};});
    const months=this.months(invoices,creditNotes,expenses,timeEntries);
    return {workspace,workspaces,business,clients,projects,timeEntries,invoices,expenses,payments,creditNotes,attachments:this.db.prepare('SELECT id,name,mime,size,sha256 FROM attachments').all() as Attachment[],insights,timer:this.setting<Timer|null>('timer'),totals:{revenueMinor:sumMoney(insights.map(i=>i.revenueMinor)),directCostsMinor:sumMoney(insights.map(i=>i.directCostsMinor)),generalCostsMinor:sumMoney(expenses.filter(e=>e.projectId===null).map(e=>e.costMinor)),outstandingMinor:sumMoney(invoices.filter(i=>i.status==='issued').map(i=>i.baseOutstandingMinor)),unbilledMinor:sumMoney(insights.map(i=>i.unbilledMinor)),workedMinutes:insights.reduce((a,i)=>a+i.workedMinutes,0),nonBillableMinutes:insights.reduce((a,i)=>a+i.workedMinutes-i.billableMinutes,0)},vatPeriods:this.vat(business,invoices,creditNotes,expenses),months,years:years(months),capabilities:{issuance:'NL-domestic-EU-export',backupVersion:1}};
  }
  execute(command:Command,requestId:string=randomUUID()):{createdId?:string;message?:string} {
    command=commandSchema.parse(command) as Command;
    const hash=createHash('sha256').update(j(command)).digest('hex');
    return this.db.transaction(()=>{
      const prev=this.db.prepare('SELECT hash,result FROM requests WHERE id=?').get(requestId) as {hash:string;result:string}|undefined;
      if(prev){if(prev.hash!==hash)throw new AppError('This request ID already belongs to a different operation.',409,'IDEMPOTENCY_CONFLICT');return JSON.parse(prev.result);}
      const result=this.mutate(command);this.state();this.audit(command.type,result.createdId);this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(requestId,hash,j(result));return result;
    }).immediate();
  }
  /** Shared by expense create/update: validates the VAT treatment and derives reverse-charge VAT and direct cost. */
  private expenseFields(d:ExpenseInput):Omit<Expense,keyof RecordMeta|'attachmentId'> {
    if(d.projectId)this.get<Project>('projects',d.projectId);
    const b=this.business(),vatTreatment=d.vatTreatment??'standard',netMinor=money(d.netAmount),taxMinor=money(d.taxAmount);
    if(netMinor+taxMinor===0)throw new AppError('Enter a positive expense.');
    if(vatTreatment!=='standard'&&taxMinor!==0)throw new AppError('Only VAT charged by the supplier goes in the tax amount. Use 0 for this VAT treatment.');
    const reverseChargeTaxMinor=REVERSE.includes(vatTreatment)?tax(netMinor,b.defaultTaxRate):0;
    const originalCurrency=d.originalCurrency??b.currency,originalAmountMinor=d.originalAmount?money(d.originalAmount):null;
    return {projectId:d.projectId,date:d.date,description:d.description,netMinor,taxMinor,deductibleTax:d.deductibleTax,costMinor:sumMoney([netMinor,d.deductibleTax?0:taxMinor,d.deductibleTax?0:reverseChargeTaxMinor]),supplier:d.supplier??'',supplierInvoiceNumber:d.supplierInvoiceNumber??'',category:d.category??'',country:d.country??'',vatTreatment,paymentMethod:d.paymentMethod??'',notes:d.notes??'',reverseChargeTaxMinor,originalCurrency,originalAmountMinor};
  }
  private mutate(cmd:Command):{createdId?:string;message?:string} {
    if('date' in cmd.data && typeof cmd.data.date==='string' && cmd.data.date>localDate()){
      if(!((cmd.type==='time.create'||cmd.type==='time.update')&&!cmd.data.approved))throw new AppError('Future work and transactions cannot be recorded as actuals. Save future time as unapproved.');
    }
    switch(cmd.type){
      case 'client.create': {const c={...meta(),contactName:'',registrationId:'',notes:'',...cmd.data};this.db.prepare('INSERT INTO clients VALUES(?,?)').run(c.id,j(c));return {createdId:c.id};}
      case 'client.update': {const old=this.revise<Client>('clients',cmd.data.id,cmd.data.revision);const c={...old,...cmd.data,revision:old.revision+1};this.db.prepare('UPDATE clients SET data=? WHERE id=?').run(j(c),c.id);return {createdId:c.id};}
      case 'project.create': case 'project.update': {
        const d=cmd.data;this.get<Client>('clients',d.clientId);const old=cmd.type==='project.update'?this.revise<Project>('projects',cmd.data.id,cmd.data.revision):null;
        if(old&&this.list<Invoice>('invoices').some(i=>i.projectId===old.id)&&(old.clientId!==d.clientId||old.kind!==d.kind||old.fixedPriceMinor!==(d.fixedPrice===null?null:money(d.fixedPrice))))throw new AppError('An invoiced project cannot change customer, pricing model or contract price.',409,'LOCKED');
        const p:Project={...(old??meta()),clientId:d.clientId,name:d.name,kind:d.kind,rateMinor:money(d.rate),fixedPriceMinor:d.kind==='fixed'?money(d.fixedPrice!):null,costsComplete:d.costsComplete,status:d.status,estimatedRemainingMinutes:d.estimatedRemainingMinutes,notes:d.notes??old?.notes??'',revision:old?old.revision+1:1};
        if(old)this.db.prepare('UPDATE projects SET client_id=?,data=? WHERE id=?').run(p.clientId,j(p),p.id);else this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(p.id,p.clientId,j(p));return {createdId:p.id};
      }
      case 'time.create': case 'time.update': {
        const d=cmd.data,p=this.get<Project>('projects',d.projectId),old=cmd.type==='time.update'?this.revise<TimeEntry>('time_entries',cmd.data.id,cmd.data.revision):null;
        if(old&&this.locked(old.id))throw new AppError('Time on a draft or issued invoice cannot be edited. Delete its draft first.',409,'LOCKED');
        // Omitted session fields keep their saved values, unless the duration changed and they would no longer match.
        const keep=old&&old.minutes===d.minutes;
        const session={startTime:d.startTime!==undefined?d.startTime:keep?old.startTime:null,endTime:d.endTime!==undefined?d.endTime:keep?old.endTime:null,notes:d.notes??old?.notes??''};
        const t:TimeEntry={...(old??meta()),...d,...session,rateMinor:old&&old.projectId===p.id?old.rateMinor:p.rateMinor,invoiceId:null,revision:old?old.revision+1:1};
        if(old)this.db.prepare('UPDATE time_entries SET project_id=?,data=? WHERE id=?').run(t.projectId,j(t),t.id);else this.db.prepare('INSERT INTO time_entries VALUES(?,?,?)').run(t.id,t.projectId,j(t));return {createdId:t.id};
      }
      case 'time.delete': {this.revise<TimeEntry>('time_entries',cmd.data.id,cmd.data.revision);if(this.locked(cmd.data.id))throw new AppError('Invoiced or reserved time cannot be deleted.',409,'LOCKED');this.db.prepare('DELETE FROM time_entries WHERE id=?').run(cmd.data.id);return {};}
      case 'invoice.draft': {
        const d=cmd.data,p=this.get<Project>('projects',d.projectId),client=this.get<Client>('clients',p.clientId),business=this.business();
        if(new Set(d.timeEntryIds).size!==d.timeEntryIds.length)throw new AppError('Select each time entry only once.');
        const times=d.timeEntryIds.map(id=>this.get<TimeEntry>('time_entries',id));
        if(times.some(t=>t.projectId!==p.id||!t.approved||!t.billable||this.locked(t.id)))throw new AppError('Only approved, unassigned billable time can be selected.',409,'TIME_ASSIGNED');
        if(p.kind==='fixed'&&this.list<Invoice>('invoices').some(i=>i.projectId===p.id))throw new AppError('The fixed contract already has a draft or issued invoice.',409,'FIXED_ALREADY_INVOICED');
        if(p.kind==='fixed'&&(d.timeEntryIds.length>0||d.extraLines.length>0))throw new AppError('Fixed contracts use one contract line. Time and extra charges are excluded.');
        // Workspace prices convert once per unit price; the document then calculates in its own currency.
        const currency=d.currency??business.currency;if(currency!==business.currency&&!d.exchangeRate)throw new AppError(`Enter the exchange rate: 1 ${business.currency} = how many ${currency}?`);
        const exchangeRate=currency===business.currency?'1':d.exchangeRate!;
        const lines:InvoiceLine[]=p.kind==='fixed'?(()=>{const unit=toDocument(p.fixedPriceMinor!,exchangeRate);return [{id:randomUUID(),description:p.name,quantity:'1',timeMinutes:null,unitPriceMinor:unit,netMinor:unit,taxRate:d.taxRate,taxMinor:tax(unit,d.taxRate),timeEntryId:null}];})():times.map(t=>{const unit=toDocument(t.rateMinor,exchangeRate),netMinor=timeAmount(t.minutes,unit);return {id:randomUUID(),description:`${t.date} · ${t.description}`,quantity:new Decimal(t.minutes).div(60).toFixed(6),timeMinutes:t.minutes,unitPriceMinor:unit,netMinor,taxRate:d.taxRate,taxMinor:tax(netMinor,d.taxRate),timeEntryId:t.id};});
        for(const e of d.extraLines){const unitPriceMinor=money(e.unitPrice),netMinor=lineAmount(e.quantity,unitPriceMinor);lines.push({id:randomUUID(),description:e.description,quantity:e.quantity,timeMinutes:null,unitPriceMinor,netMinor,taxRate:e.taxRate,taxMinor:tax(netMinor,e.taxRate),timeEntryId:null});}
        if(lines.length===0)throw new AppError('Select time or add an invoice line.');
        const netMinor=sumMoney(lines.map(l=>l.netMinor)),taxMinor=sumMoney(lines.map(l=>l.taxMinor)),totalMinor=sumMoney([netMinor,taxMinor]);
        const baseNetMinor=toBase(netMinor,exchangeRate),baseTaxMinor=toBase(taxMinor,exchangeRate),baseTotalMinor=sumMoney([baseNetMinor,baseTaxMinor]);
        const invoice:Invoice={...meta(),projectId:p.id,clientId:client.id,status:'draft',number:null,issueDate:d.issueDate,supplyDate:d.supplyDate,dueDate:d.dueDate,notes:d.notes,lines,netMinor,taxMinor,totalMinor,business,client,currency,issuedAt:null,outstandingMinor:totalMinor,paidMinor:0,creditedMinor:0,issueBlockers:[],exchangeRate,taxTreatment:taxTreatment(client.country),baseNetMinor,baseTaxMinor,baseTotalMinor,baseOutstandingMinor:baseTotalMinor};
        this.db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?)').run(invoice.id,p.id,client.id,'draft',null,j(invoice));for(const t of times)this.db.prepare('INSERT INTO draft_times VALUES(?,?)').run(t.id,invoice.id);return {createdId:invoice.id};
      }
      case 'invoice.issue': {
        const i=this.revise<Invoice>('invoices',cmd.data.id,cmd.data.revision);if(i.status!=='draft')throw new AppError('This invoice is already issued.',409,'ALREADY_ISSUED');const blockers=this.blockers(i);if(blockers.length)throw new AppError(blockers.join(' '),422,'UNSUPPORTED_ISSUANCE');
        const business=this.business(),client=this.get<Client>('clients',i.clientId);if(business.nextInvoiceNumber>=999999999)throw new AppError('Invoice sequence is exhausted. Export your records before starting a new supported sequence.',409,'SEQUENCE_EXHAUSTED');const number=`${business.invoicePrefix}-${i.issueDate.slice(0,4)}-${String(business.nextInvoiceNumber).padStart(4,'0')}`;
        for(const l of i.lines.filter(l=>l.timeEntryId)){const t=this.get<TimeEntry>('time_entries',l.timeEntryId!);if(!t.approved||!t.billable)throw new AppError('Time needs approval.',409);const reservation=this.db.prepare('SELECT invoice_id FROM draft_times WHERE time_id=?').get(t.id) as {invoice_id:string}|undefined;if(reservation?.invoice_id!==i.id)throw new AppError('Time reservation changed.',409,'TIME_ASSIGNED');this.db.prepare('INSERT INTO allocations VALUES(?,?)').run(t.id,i.id);}
        const issued={...i,status:'issued' as const,number,business,client,issuedAt:new Date().toISOString(),revision:i.revision+1,issueBlockers:[]};
        this.db.prepare('UPDATE invoices SET status=?,number=?,data=? WHERE id=?').run('issued',number,j(issued),i.id);this.db.prepare('DELETE FROM draft_times WHERE invoice_id=?').run(i.id);this.set('business',{...business,nextInvoiceNumber:business.nextInvoiceNumber+1,revision:business.revision+1});return {createdId:i.id};
      }
      case 'invoice.deleteDraft': {const i=this.revise<Invoice>('invoices',cmd.data.id,cmd.data.revision);if(i.status!=='draft')throw new AppError('Issued invoices cannot be deleted.',409,'LOCKED');this.db.prepare('DELETE FROM invoices WHERE id=?').run(i.id);return {};}
      case 'payment.create': {
        const d=cmd.data,i=this.state().invoices.find(i=>i.id===d.invoiceId);if(!i||i.status!=='issued')throw new AppError('Payments require an issued invoice.');const amountMinor=money(d.amount);if(amountMinor<=0||amountMinor>i.outstandingMinor)throw new AppError('Payment must be positive and no greater than the amount due.');const p:Payment={...meta(),invoiceId:i.id,date:d.date,amountMinor,reference:d.reference,reversalOf:null};this.db.prepare('INSERT INTO payments VALUES(?,?,?,?)').run(p.id,i.id,null,j(p));return {createdId:p.id};
      }
      case 'payment.reverse': {const original=this.get<Payment>('payments',cmd.data.id);if(original.reversalOf||this.list<Payment>('payments').some(p=>p.reversalOf===original.id))throw new AppError('This payment has already been reversed or is a reversal.',409,'ALREADY_REVERSED');const p:Payment={...meta(),invoiceId:original.invoiceId,date:cmd.data.date,amountMinor:-original.amountMinor,reference:cmd.data.reason,reversalOf:original.id};this.db.prepare('INSERT INTO payments VALUES(?,?,?,?)').run(p.id,p.invoiceId,p.reversalOf,j(p));return {createdId:p.id};}
      case 'credit.create': {
        const d=cmd.data,i=this.get<Invoice>('invoices',d.invoiceId);if(i.status!=='issued')throw new AppError('Credits require an issued invoice.');const previous=this.list<CreditNote>('credits').filter(c=>c.invoiceId===i.id);const netMinor=money(d.netAmount),remaining=i.netMinor-sumMoney(previous.map(c=>c.netMinor));if(netMinor<=0||netMinor>remaining)throw new AppError('Credit must be positive and no greater than the remaining net invoice value.');if(new Set(i.lines.map(l=>l.taxRate)).size!==1)throw new AppError('Mixed tax credits are not supported.');const remainingTax=i.taxMinor-sumMoney(previous.map(c=>c.taxMinor));const taxMinor=netMinor===remaining?remainingTax:Math.min(remainingTax,tax(netMinor,i.lines[0].taxRate));const next=this.setting<number>('nextCredit');if(next>=999999999)throw new AppError('Credit sequence is exhausted.',409,'SEQUENCE_EXHAUSTED');const number=`CN-${d.date.slice(0,4)}-${String(next).padStart(4,'0')}`;const c:CreditNote={...meta(),invoiceId:i.id,number,date:d.date,reason:d.reason,netMinor,taxMinor,totalMinor:sumMoney([netMinor,taxMinor]),baseNetMinor:toBase(netMinor,i.exchangeRate),baseTaxMinor:toBase(taxMinor,i.exchangeRate)};this.db.prepare('INSERT INTO credits VALUES(?,?,?,?)').run(c.id,i.id,number,j(c));this.set('nextCredit',next+1);return {createdId:c.id};
      }
      case 'expense.create': {const {attachment:upload,...d}=cmd.data;const fields=this.expenseFields(d);const attachment=upload?this.attachment(upload):null;const e:Expense={...meta(),...fields,attachmentId:attachment?.id??null};this.db.prepare('INSERT INTO expenses VALUES(?,?,?,?)').run(e.id,e.projectId,e.attachmentId,j(e));return {createdId:e.id};}
      case 'expense.update': {const {id,revision,...d}=cmd.data;const old=this.revise<Expense>('expenses',id,revision);const e:Expense={...old,...this.expenseFields(d),revision:old.revision+1};this.db.prepare('UPDATE expenses SET project_id=?,data=? WHERE id=?').run(e.projectId,j(e),e.id);return {createdId:e.id};}
      case 'expense.delete': {const e=this.revise<Expense>('expenses',cmd.data.id,cmd.data.revision);this.db.prepare('DELETE FROM expenses WHERE id=?').run(e.id);return {};}
      case 'business.update': {
        const d=cmd.data,b=this.business();if(d.revision!==b.revision)throw new AppError('Settings changed in another tab. Refresh first.',409,'REVISION_CONFLICT');
        if(d.currency!==b.currency&&(this.list<Client>('clients').length||this.list<Project>('projects').length||this.list<Invoice>('invoices').length||this.list<Expense>('expenses').length))throw new AppError('Create a new workspace to change currency. Existing amounts cannot be relabelled.',409,'CURRENCY_LOCKED');
        if(d.nextInvoiceNumber!==undefined&&d.nextInvoiceNumber<b.nextInvoiceNumber)throw new AppError('The next invoice number cannot move backwards.');if(d.invoicePrefix.toUpperCase()==='CN')throw new AppError('CN is reserved for credit note numbers. Use a different invoice prefix.');
        let logoId=b.logoId;if(d.logo){if(d.logo.mime==='application/pdf')throw new AppError('Use a PNG or JPEG logo.');logoId=this.attachment(d.logo).id;}else if(d.logo===null)logoId=null;
        const {logo,...fields}=d;this.set('business',{...b,...fields,logoId,revision:b.revision+1});this.set('workspace',{...this.setting<Workspace>('workspace'),currency:d.currency});return {};
      }
      case 'vat.filing': {
        const d=cmd.data;if(d.filedOn&&d.filedOn>localDate())throw new AppError('A filing date cannot be in the future.');
        const filings=this.setting<Record<string,VatFiling>>('vatFilings')??{};this.set('vatFilings',{...filings,[d.period]:{...d,filedOn:d.status==='filed'?d.filedOn??localDate():d.filedOn}});return {};
      }
      case 'timer.start': {if(this.setting<Timer|null>('timer'))throw new AppError('Stop and review the active timer first.',409,'TIMER_ACTIVE');this.get<Project>('projects',cmd.data.projectId);this.set('timer',{...cmd.data,startedAt:new Date().toISOString()});return {};}
      case 'timer.stop': {const timer=this.setting<Timer|null>('timer');if(!timer)throw new AppError('There is no active timer.',409,'NO_TIMER');const result=this.mutate({type:'time.create',data:{projectId:timer.projectId,description:timer.description,category:timer.category,billable:timer.billable,...cmd.data}});this.set('timer',null);return result;}
      default: throw new AppError('Workspace and restore commands are managed by the local API.');
    }
  }
}

/**
 * Fictional demo studio: nine months of a healthy one-person automation & design business.
 * Every figure comes from records created through the normal commands, so the totals stay consistent.
 * The Llama Labs (€105/h) vs Meeting Hydra (€50/h) comparison is the scripted demo story; keep its numbers.
 */
export function seedDemo(store:WorkspaceStore){
  const exec=(c:Command)=>store.execute(c).createdId!;
  const b=store.business();exec({type:'business.update',data:{...b,name:'Paper & Pine Studio',address:'42 Example Lane\n1234 AB Amsterdam',legalForm:'Sole proprietor',taxRegistered:true,taxId:'NL000000000B00',registrationId:'00000000',paymentInstructions:'Demo only · Example account NL00 DEMO 0000 0000 00',invoicePrefix:'DEMO'}});
  const USD='1.17'; // 1 EUR = 1.17 USD for every dollar amount below
  const client=(name:string,address:string,country='NL',taxId='',contactName='A. Example')=>exec({type:'client.create',data:{name,address,country,email:'',taxId,contactName}});
  const project=(clientId:string,name:string,price:{rate?:string;fixed?:string},status:Project['status']='complete',extra:{costsComplete?:boolean;remaining?:number|null}={})=>exec({type:'project.create',data:{clientId,name,kind:price.fixed?'fixed':'hourly',rate:price.rate??'0.00',fixedPrice:price.fixed??null,costsComplete:extra.costsComplete??true,status,estimatedRemainingMinutes:extra.remaining??0}});
  const work=(projectId:string,date:string,minutes:number,description:string,category='Delivery',billable=true)=>exec({type:'time.create',data:{projectId,date,minutes,description,category,billable,approved:true}});
  /** Net amount in EUR; usd converts a dollar price and books it as a non-EU import (reverse charge). */
  const cost=(projectId:string|null,date:string,description:string,supplier:string,category:string,price:{eur?:string;usd?:string;vat?:'standard'|'none'|'intra-eu';country?:string},paymentMethod='Credit card',extra:{deductibleTax?:boolean;taxAmount?:string;supplierInvoiceNumber?:string;attachment?:Upload|null}={})=>{
    const net=price.usd?new Decimal(price.usd).div(USD).toFixed(2):price.eur!,vatTreatment=price.usd?'import-non-eu':price.vat??'standard';
    exec({type:'expense.create',data:{projectId,date,description,netAmount:net,taxAmount:extra.taxAmount??(vatTreatment==='standard'?new Decimal(net).mul('0.21').toFixed(2):'0'),deductibleTax:extra.deductibleTax??true,supplier,supplierInvoiceNumber:extra.supplierInvoiceNumber??'',category,country:price.usd?'US':price.country??'NL',vatTreatment,paymentMethod,...(price.usd?{originalCurrency:'USD',originalAmount:price.usd}:{}),attachment:extra.attachment??null}});
  };
  // Drafts first; they are issued afterwards in date order so invoice numbers run chronologically.
  const issue:{date:string;id:string}[]=[];
  const invoice=(projectId:string,timeEntryIds:string[],issueDate:string,dueDate:string,options:{taxRate?:string;currency?:string;notes?:string}={})=>{const id=exec({type:'invoice.draft',data:{projectId,timeEntryIds,issueDate,supplyDate:issueDate,dueDate,taxRate:options.taxRate??'21',notes:options.notes??'Fictional demonstration invoice.',extraLines:[],...(options.currency?{currency:options.currency,exchangeRate:USD}:{})}});issue.push({date:issueDate,id});return id;};
  const paidInFull=(invoiceId:string,date:string,reference:string)=>{const i=store.state().invoices.find(x=>x.id===invoiceId)!;exec({type:'payment.create',data:{invoiceId,date,amount:(i.outstandingMinor/100).toFixed(2),reference}});};
  const months=['01','02','03','04','05','06','07','08','09'];

  // 1 · The monthly retainer that pays the rent.
  const heroes=project(client('Inbox Zero Heroes BV','7 Quiet Inbox Street\n3511 AB Utrecht'),'Automation autopilot (monthly retainer)',{rate:'135.00'},'active');
  const wins=['Untangled the onboarding workflow spaghetti','Auto-tagged 4,000 unread emails','Invoice chaser bot (politely persistent)','CRM dedupe: farewell, 312 duplicate Daves','Slack alarm when a big lead lands','Fixed the webhook that cried wolf','Summer-proofed the auto-replies','Monthly report bot, now with charts'];
  const retainer:string[]=[];
  months.forEach((m,n)=>{
    cost(heroes,`2026-${m}-02`,'Client workspace · extra automation task credits','Flowmatic Cloud','Software',{eur:'19.00'});
    if(m==='09'){work(heroes,'2026-09-08',360,'Lead scoring tweaks');work(heroes,'2026-09-29',60,'Monthly check-in call & report','Meeting',false);return;}
    const ids=[work(heroes,`2026-${m}-06`,420,wins[n]),work(heroes,`2026-${m}-14`,300,'Monitoring, fixes & small requests','Development')];
    work(heroes,`2026-${m}-24`,120,'Monthly check-in call & report','Meeting',false);
    retainer.push(invoice(heroes,ids,`2026-${m}-28`,`2026-${months[n+1]}-11`));
  });

  // 2 · The star: a productised bot sold at a fixed price.
  const bakery=project(client('Knead for Speed Bakery','12 Crumb Corner\n2011 CD Haarlem'),'Sourdough order bot',{fixed:'7500.00'});
  work(bakery,'2026-02-05',180,'Discovery call: what does “the usual” mean?','Preparation',false);
  work(bakery,'2026-02-12',420,'Order bot: menu & pre-orders','Development');work(bakery,'2026-02-19',420,'WhatsApp order flow','Development');work(bakery,'2026-02-26',420,'Sourdough stock tracker','Development');
  work(bakery,'2026-03-05',420,'Pickup reminders & no-show nudges','Development');work(bakery,'2026-03-12',420,'Tested with 40 very hungry beta customers');
  work(bakery,'2026-03-19',180,'Training the bakery team','Meeting',false);work(bakery,'2026-03-26',120,'Aftercare: croissant emoji support','Aftercare',false);
  cost(bakery,'2026-02-20','SMS & WhatsApp message credits','Text-a-Lot Messaging BV','Software',{eur:'85.00'});
  cost(bakery,'2026-03-10','AI model usage for the order bot','Robot Brain Co.','Software / AI',{usd:'48.00'});
  const bakeryInvoice=invoice(bakery,[],'2026-03-31','2026-04-14');

  // 3 · The cautionary tale: a fixed price without a revision limit.
  const pete=project(client('Pixel Perfect Pete','99 Nitpick Avenue\n6811 EF Arnhem','NL','','Pete Example'),'Just one more tweak (website)',{fixed:'2000.00'});
  ['2026-04-07','2026-04-08','2026-04-14','2026-04-15'].forEach((d,n)=>work(pete,d,420,['Homepage & layout','Product pages','Contact form & booking','Launch checklist'][n],'Development'));
  ['Tweak round 1: make the logo bigger','Tweak round 2: make the logo smaller','Tweak round 3: “can it pop more?”','Tweak round 4: back to version 1','Tweak round 5: Pete’s nephew had ideas','Tweak round 6: final_FINAL_v7'].forEach((d,n)=>work(pete,`2026-05-${String(4+n*4).padStart(2,'0')}`,360,d,'Aftercare',false));
  cost(pete,'2026-04-06','Premium website theme licence','Theme Forge Ltd','Software',{eur:'59.00'},'PayPal');
  cost(pete,'2026-04-09','Stock photos of extremely happy people','Smile Stock','Materials',{eur:'40.00'});
  const peteInvoice=invoice(pete,[],'2026-05-29','2026-06-12');

  // 4 · An EU client: reverse-charged, 0% VAT, lands in VAT box 3b.
  const widgets=project(client('Wunderbar Widgets GmbH','1 Beispielstraße\n10115 Berlin','DE','DE000000000','B. Beispiel'),'Spreadsheet exorcism',{rate:'135.00'});
  const widgetTime=[work(widgets,'2026-06-03',480,'Day 1: the macros screamed'),work(widgets,'2026-06-04',480,'Rebuilt 37 tabs into one clean database','Development'),work(widgets,'2026-06-10',480,'Automated the weekly stock report','Development'),work(widgets,'2026-06-12',480,'On-site workshop: “Never again, Excel”')];
  work(widgets,'2026-06-11',300,'Train to Berlin & back','Travel',false);
  cost(widgets,'2026-06-11','Train tickets Amsterdam–Berlin','Choo Choo Rail','Travel',{eur:'129.00',vat:'none'},'iDEAL');
  const widgetInvoice=invoice(widgets,widgetTime,'2026-06-30','2026-07-30',{taxRate:'0'});

  // 5 · A US client, invoiced in dollars.
  const yeehaw=project(client('Yeehaw Ventures LLC','1 Example Road\nAustin, TX 78701','US','','C. Example'),'Lead-gen agent rodeo',{rate:'150.00'});
  work(yeehaw,'2026-07-02',120,'Kickoff call at 23:00 (time zones!)','Meeting',false);
  const yeehawTime=[work(yeehaw,'2026-07-07',480,'Wrangled 10,000 leads into one sheet','Development'),work(yeehaw,'2026-07-08',480,'Cold email writer that doesn’t sound cold','Development'),work(yeehaw,'2026-07-14',480,'CRM sync & duplicate roundup','Development'),work(yeehaw,'2026-07-15',240,'Handover & documentation','Documentation')];
  work(yeehaw,'2026-07-21',120,'Answering “quick questions” from Texas','Aftercare',false);
  cost(yeehaw,'2026-07-09','Lead data enrichment credits','Lasso Leads Inc.','Software / AI',{usd:'79.00'});
  const yeehawInvoice=invoice(yeehaw,yeehawTime,'2026-07-31','2026-08-30',{taxRate:'0',currency:'USD'});

  // 6 + 7 · The scripted comparison: more revenue is not automatically the better project.
  const make=(name:string,rate:string,billable:number,unpaid:number,cost:string)=>{const clientId=client(name,'8 Fictional Street\n1234 CD Amsterdam');const projectId=project(clientId,name==='Llama Labs'?'The quiet launch':'The meeting marathon',{rate});const ids:string[]=[];let remaining=billable;let day=15;while(remaining){const m=Math.min(480,remaining);ids.push(work(projectId,`2026-09-${day++}`,m,'Design & delivery'));remaining-=m;}remaining=unpaid;while(remaining){const m=Math.min(480,remaining);work(projectId,`2026-09-${day++}`,m,'Preparation, meetings & aftercare','Aftercare',false);remaining-=m;}const invoiceId=invoice(projectId,ids,'2026-09-25','2026-10-25');exec({type:'expense.create',data:{projectId,date:'2026-09-24',description:'Direct project production costs',netAmount:cost,taxAmount:'0',deductibleTax:true,supplier:'Fictional Print Works',category:'Materials',country:'NL',vatTreatment:'none',paymentMethod:'Bank transfer',attachment:{name:'demo-receipt.pdf',mime:'application/pdf',base64:demoReceiptPdf().toString('base64')}}});return {projectId,invoiceId};};
  const llama=make('Llama Labs','150.00',960,240,'300.00');make('Meeting Hydra','100.00',1800,1200,'500.00');
  exec({type:'time.create',data:{projectId:llama.projectId,date:'2026-10-01',minutes:90,description:'Optional follow-up workshop (review before billing)',category:'Preparation',billable:true,approved:false,startTime:'09:30',endTime:'11:00'}});

  // 8 · Work in progress: fixed contract, direct costs not final yet, so its return stays unknown.
  const chompers=project(client('Chompers Dental Clinic','3 Molar Lane\n5611 GH Eindhoven'),'AI receptionist that never sleeps',{fixed:'6000.00'},'active',{costsComplete:false,remaining:1500});
  work(chompers,'2026-09-02',120,'Kickoff: the receptionist must never sleep','Meeting',false);
  work(chompers,'2026-09-03',420,'Voice agent: booking & rescheduling','Development');work(chompers,'2026-09-09',420,'Calendar sync with the dental chairs','Development');
  work(chompers,'2026-09-23',420,'Teaching it to say “floss” politely','Development');work(chompers,'2026-09-30',300,'Emergency toothache escalation flow','Development');
  cost(chompers,'2026-09-04','Voice minutes for testing','Voice Clone Club','Software / AI',{usd:'22.00'});

  // General business costs: the subscriptions most builders will recognise.
  months.forEach(m=>{
    cost(null,`2026-${m}-01`,'AI assistant · Pro plan','Robot Brain Co.','Software / AI',{usd:'20.00'});
    cost(null,`2026-${m}-01`,'Automation platform · Pro plan','Flowmatic Cloud GmbH','Software',{eur:'24.00',vat:'intra-eu',country:'DE'});
    cost(null,`2026-${m}-01`,'Hot desk, three days a week','The Hive Coworking','Co-working & office',{eur:'175.00'},'Direct debit');
    cost(null,`2026-${m}-03`,'Mobile & fibre internet','Chatty Telecom','Telephone & internet',{eur:'45.00'},'Direct debit');
    cost(null,`2026-${m}-05`,'Website hosting','Hostess with the Mostest','Website & hosting',{eur:'12.00'});
    cost(null,`2026-${m}-10`,'Design software · all apps',`Pixelpalooza Inc.`,'Software',{usd:'54.00'},'Credit card',{supplierInvoiceNumber:`PX-26${m}`});
    cost(null,`2026-${m}-12`,'Mastermind community membership','The Grandmaster Guild','Memberships',{usd:'99.00'});
    cost(null,`2026-${m}-28`,'Business account fees','Piggy Bank NV','Bank fees',{eur:'8.50',vat:'none'},'Direct debit');
  });
  cost(null,'2026-01-08','Domain names · three years','Dot Com Dot Calm','Domain names',{eur:'36.00'});
  cost(null,'2026-02-10','Prompt engineering course','Prompt Dojo','Training',{eur:'297.00'},'iDEAL');
  cost(null,'2026-04-16','Client lunch · bakery bot launch','The Hungry Llama Café','Hospitality & representation',{eur:'54.13'},'Credit card',{taxAmount:'4.87',deductibleTax:false});
  cost(null,'2026-05-20','Noise-cancelling headphones (for meeting marathons)','Gadget Goblin','Other',{eur:'229.00'},'iDEAL');
  ['03-31','06-30','09-30'].forEach(d=>cost(null,`2026-${d}`,'Bookkeeper · quarterly VAT check','Beancounters & Co','Other',{eur:'150.00'},'Bank transfer'));

  // Issue every draft in date order, then record what came in.
  for(const x of issue.sort((a,b)=>a.date.localeCompare(b.date)))exec({type:'invoice.issue',data:{id:x.id,revision:1}});
  retainer.forEach((id,n)=>paidInFull(id,`2026-${months[n+1]}-08`,'Paid on time, as always'));
  paidInFull(bakeryInvoice,'2026-04-13','Paid in fresh bread money');
  exec({type:'credit.create',data:{invoiceId:peteInvoice,date:'2026-06-05',netAmount:'100.00',reason:'Goodwill: we agreed the font is fine'}});
  exec({type:'payment.create',data:{invoiceId:peteInvoice,date:'2026-06-28',amount:'1000.00',reference:'First half, eventually'}});paidInFull(peteInvoice,'2026-07-15','Finally');
  paidInFull(widgetInvoice,'2026-07-10','Pünktlich');
  paidInFull(yeehawInvoice,'2026-08-12','Wire from Texas');
  exec({type:'payment.create',data:{invoiceId:llama.invoiceId,date:'2026-09-28',amount:'1200.00',reference:'Fictional part payment'}});
  exec({type:'vat.filing',data:{period:'Q1 2026',status:'filed',filedOn:'2026-04-28',note:'Filed online'}});
  exec({type:'vat.filing',data:{period:'Q2 2026',status:'filed',filedOn:'2026-07-29',note:'Filed online'}});
}
function demoReceiptPdf(){const stream='BT /F1 16 Tf 50 750 Td (FICTIONAL DEMO RECEIPT - Paper & Pine) Tj ET';const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];let pdf='%PDF-1.4\n';const offsets=[0];for(let n=0;n<objs.length;n++){offsets.push(Buffer.byteLength(pdf));pdf+=`${n+1} 0 obj\n${objs[n]}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf);}

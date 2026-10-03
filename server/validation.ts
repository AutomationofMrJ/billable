import { z } from 'zod';
import { isCountry, isCurrency } from '../shared/geo';
import { EXPENSE_VAT, PROJECT_STATUSES } from '../shared/types';
export const id = z.string().uuid();
const text = z.string().trim().max(4000);
const name = z.string().trim().min(1).max(200);
const amount = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Use a positive amount with at most two decimals.');
const rate = z.string().regex(/^\d{1,3}(\.\d{1,3})?$/).refine(v => Number(v) <= 100, 'Tax rate must be between 0 and 100.');
const exchangeRate = z.string().regex(/^\d{1,7}(\.\d{1,6})?$/, 'Use an exchange rate with at most six decimals.').refine(v => Number(v) > 0 && Number(v) <= 1_000_000, 'Exchange rate must be above 0.');
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T12:00:00Z`); return !isNaN(d.valueOf()) && d.toISOString().slice(0,10) === v; }, 'Use a real calendar date.');
const country = z.string().refine(isCountry, 'Choose a country from the list.');
const currency = z.string().refine(isCurrency, 'Choose a currency from the list.');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 09:30.');
const category = z.string().trim().min(1).max(60);
const short = z.string().trim().max(200);
const rev = { id, revision: z.number().int().positive() };
const upload = z.object({ name: name.refine(v => !/[\\/\x00-\x1f]/.test(v),'Use a plain file name.'), mime: z.enum(['image/png','image/jpeg','application/pdf']), base64: z.string().min(4).max(7_000_000) });
const client = z.object({ name, address: text, country, email: z.union([z.literal(''),z.email()]), taxId: z.string().max(100), contactName: short.optional(), registrationId: z.string().max(100).optional(), notes: text.optional() });
const project = z.object({ clientId: id, name, kind: z.enum(['hourly','fixed']), rate: amount, fixedPrice: amount.nullable(), costsComplete: z.boolean(), status: z.enum(PROJECT_STATUSES), estimatedRemainingMinutes: z.number().int().min(0).max(6_000_000).nullable(), notes: text.optional() }).refine(v => v.kind !== 'fixed' || v.fixedPrice !== null, 'Fixed projects need a contract price.');
const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const time = z.object({ projectId: id, date, minutes: z.number().int().min(1).max(1440), description: name, category, billable: z.boolean(), approved: z.boolean(), startTime: clock.nullable().optional(), endTime: clock.nullable().optional(), notes: text.optional() });
// Start and end describe one same-day session; the stored minutes stay authoritative for money.
const sessionMatches = (v: { minutes: number; startTime?: string | null; endTime?: string | null }) => !v.startTime || !v.endTime || minutesOf(v.endTime) - minutesOf(v.startTime) === v.minutes;
const sessionMessage = 'Start and end time must match the minutes worked (same day).';
const draft = z.object({ projectId: id, timeEntryIds: z.array(id).max(500), issueDate: date, supplyDate: date, dueDate: date, taxRate: rate, notes: text, extraLines: z.array(z.object({ description: name, quantity: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/).refine(v=>Number(v)>0), unitPrice: amount, taxRate: rate })).max(100), currency: currency.optional(), exchangeRate: exchangeRate.optional() }).refine(v=>v.dueDate >= v.issueDate,'Due date must follow the invoice date.');
const expense = z.object({ projectId: id.nullable(), date, description: name, netAmount: amount, taxAmount: amount, deductibleTax: z.boolean(), supplier: short.optional(), supplierInvoiceNumber: z.string().trim().max(100).optional(), category: z.string().trim().max(60).optional(), country: z.union([z.literal(''), country]).optional(), vatTreatment: z.enum(EXPENSE_VAT).optional(), paymentMethod: z.string().trim().max(60).optional(), notes: text.optional(), originalCurrency: currency.optional(), originalAmount: amount.nullable().optional() });
const business = z.object({ name, address: text, country, region: z.string().max(200), legalForm: z.string().max(200), taxRegistered: z.boolean(), taxId: z.string().max(100), registrationId: z.string().max(100), currency, invoicePrefix: z.string().regex(/^[A-Za-z0-9-]{1,20}$/), nextInvoiceNumber: z.number().int().min(1).max(999999999).optional(), paymentInstructions: text, defaultTaxRate: rate, revision: z.number().int().positive(), logo: upload.nullable().optional(), vatFrequency: z.enum(['quarterly','monthly','annual']).optional(), smallBusinessScheme: z.boolean().optional() });
export const commandSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('client.create'),data:client}), z.object({type:z.literal('client.update'),data:client.extend(rev)}),
  z.object({type:z.literal('project.create'),data:project}), z.object({type:z.literal('project.update'),data:project.safeExtend(rev)}),
  z.object({type:z.literal('time.create'),data:time.refine(sessionMatches, sessionMessage)}), z.object({type:z.literal('time.update'),data:time.extend(rev).refine(sessionMatches, sessionMessage)}), z.object({type:z.literal('time.delete'),data:z.object(rev)}),
  z.object({type:z.literal('invoice.draft'),data:draft}), z.object({type:z.literal('invoice.issue'),data:z.object(rev)}), z.object({type:z.literal('invoice.deleteDraft'),data:z.object(rev)}),
  z.object({type:z.literal('payment.create'),data:z.object({invoiceId:id,date,amount,reference:text})}), z.object({type:z.literal('payment.reverse'),data:z.object({id,date,reason:name})}),
  z.object({type:z.literal('credit.create'),data:z.object({invoiceId:id,date,netAmount:amount,reason:name})}),
  z.object({type:z.literal('expense.create'),data:expense.extend({attachment:upload.nullable()})}), z.object({type:z.literal('expense.update'),data:expense.extend(rev)}), z.object({type:z.literal('expense.delete'),data:z.object(rev)}),
  z.object({type:z.literal('business.update'),data:business}),
  z.object({type:z.literal('vat.filing'),data:z.object({period:z.string().regex(/^(Q[1-4] \d{4}|\d{4}-\d{2}|\d{4})$/),status:z.enum(['todo','filed','not-applicable']),filedOn:date.nullable(),note:text})}),
  z.object({type:z.literal('workspace.create'),data:z.object({name,currency,demo:z.boolean()})}),
  z.object({type:z.literal('workspace.switch'),data:z.object({id})}),
  z.object({type:z.literal('backup.restore'),data:z.object({name,base64:z.string().min(4).max(190_000_000)})}),
  z.object({type:z.literal('timer.start'),data:z.object({projectId:id,description:name,category,billable:z.boolean()})}),
  z.object({type:z.literal('timer.stop'),data:z.object({minutes:z.number().int().min(1).max(1440),date,approved:z.boolean()})})
]);
export const envelopeSchema = z.object({requestId:id,workspaceId:id,command:commandSchema});
export class AppError extends Error { constructor(message:string, public status=400, public code='VALIDATION') { super(message); } }

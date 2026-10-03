export const BRAND = { name: 'Billable', tagline: 'Know what your work is worth.' };
export type Money = number; // Safe integer in the workspace currency's smallest unit (2 decimals).
export type Id = string;
export interface RecordMeta { id: Id; revision: number; createdAt: string; }
export interface Workspace { id: Id; name: string; demo: boolean; currency: string; }
export type VatFrequency = 'quarterly' | 'monthly' | 'annual';
export interface BusinessProfile {
  name: string; address: string; country: string; region: string; legalForm: string;
  taxRegistered: boolean; taxId: string; registrationId: string; currency: string;
  invoicePrefix: string; nextInvoiceNumber: number; paymentInstructions: string;
  defaultTaxRate: string; logoId: Id | null; revision: number;
  /** How often VAT returns are filed; groups the VAT overview. */
  vatFrequency: VatFrequency;
  /** Small business scheme (e.g. Dutch KOR): no VAT is charged or reclaimed. */
  smallBusinessScheme: boolean;
}
export interface Client extends RecordMeta {
  name: string; address: string; country: string; email: string; taxId: string;
  contactName: string; registrationId: string; notes: string;
}
export const PROJECT_STATUSES = ['quote', 'active', 'paused', 'complete', 'cancelled'] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];
export interface Project extends RecordMeta {
  clientId: Id; name: string; kind: 'hourly' | 'fixed'; rateMinor: Money;
  fixedPriceMinor: Money | null; costsComplete: boolean; status: ProjectStatus;
  estimatedRemainingMinutes: number | null; notes: string;
}
/** Suggested work categories; any short category text is accepted. */
export const TIME_CATEGORIES = ['Delivery', 'Preparation', 'Meeting', 'Aftercare', 'Communication', 'Concept development', 'Development', 'Documentation', 'Travel', 'Other'] as const;
export interface TimeEntry extends RecordMeta {
  projectId: Id; date: string; minutes: number; description: string;
  category: string; billable: boolean; approved: boolean; rateMinor: Money; invoiceId: Id | null;
  /** Optional local clock times (HH:MM); when both are present they match the minutes. */
  startTime: string | null; endTime: string | null; notes: string;
}
export interface InvoiceLine { id: Id; description: string; quantity: string; timeMinutes: number | null; unitPriceMinor: Money; netMinor: Money; taxRate: string; taxMinor: Money; timeEntryId: Id | null; }
/** Derived from the customer country when the draft is created. */
export type TaxTreatment = 'domestic' | 'eu-reverse-charge' | 'outside-eu' | 'unknown';
export interface Invoice extends RecordMeta {
  projectId: Id; clientId: Id; status: 'draft' | 'issued'; number: string | null;
  issueDate: string; supplyDate: string; dueDate: string; notes: string;
  /** Line amounts, totals, payments and credits are in the document currency. */
  lines: InvoiceLine[]; netMinor: Money; taxMinor: Money; totalMinor: Money;
  business: BusinessProfile; client: Client; currency: string; issuedAt: string | null;
  outstandingMinor: Money; paidMinor: Money; creditedMinor: Money;
  issueBlockers: string[];
  /** 1 workspace-currency unit = exchangeRate document-currency units ("1" for the workspace currency). */
  exchangeRate: string; taxTreatment: TaxTreatment;
  /** Workspace-currency equivalents used for revenue, VAT and reports. */
  baseNetMinor: Money; baseTaxMinor: Money; baseTotalMinor: Money; baseOutstandingMinor: Money;
}
export interface Payment extends RecordMeta { invoiceId: Id; date: string; amountMinor: Money; reference: string; reversalOf: Id | null; }
export interface CreditNote extends RecordMeta { invoiceId: Id; number: string; date: string; reason: string; netMinor: Money; taxMinor: Money; totalMinor: Money; baseNetMinor: Money; baseTaxMinor: Money; }
export interface Attachment { id: Id; name: string; mime: string; size: number; sha256: string; }
export const EXPENSE_VAT = ['standard', 'none', 'reverse-domestic', 'import-non-eu', 'intra-eu'] as const;
export type ExpenseVat = typeof EXPENSE_VAT[number];
export const EXPENSE_CATEGORIES = ['Software', 'Software / AI', 'Website & hosting', 'Domain names', 'Telephone & internet', 'Travel', 'Co-working & office', 'Memberships', 'Bank fees', 'Hospitality & representation', 'Taxes & levies', 'Subcontractors', 'Materials', 'Training', 'Other'] as const;
export const PAYMENT_METHODS = ['Bank transfer', 'Credit card', 'Direct debit', 'iDEAL', 'PayPal', 'Cash', 'Paid privately'] as const;
export interface Expense extends RecordMeta {
  /** Null for general business costs that belong to no single project. */
  projectId: Id | null; date: string; description: string;
  netMinor: Money; taxMinor: Money; deductibleTax: boolean; costMinor: Money; attachmentId: Id | null;
  supplier: string; supplierInvoiceNumber: string; category: string; country: string;
  vatTreatment: ExpenseVat; paymentMethod: string; notes: string;
  /** VAT you self-assess under reverse charge, in the workspace currency (0 otherwise). */
  reverseChargeTaxMinor: Money;
  /** Original currency and amount as charged by the supplier (informational). */
  originalCurrency: string; originalAmountMinor: Money | null;
}
export interface ProjectInsight {
  projectId: Id; revenueMinor: Money; directCostsMinor: Money; contributionMinor: Money | null;
  contributionPerHourMinor: Money | null; workedMinutes: number; billableMinutes: number;
  unbilledMinutes: number; unbilledMinor: Money; contractedMinor: Money | null;
  provisional: boolean;
}
export interface Timer { projectId: Id; startedAt: string; description: string; category: string; billable: boolean; }
export interface VatFiling { period: string; status: 'todo' | 'filed' | 'not-applicable'; filedOn: string | null; note: string; }
export interface VatRow { code: string; label: string; netMinor: Money; taxMinor: Money; }
export interface VatPeriod {
  period: string; start: string; end: string; rows: VatRow[];
  /** Total VAT due (5a), input VAT (5b) and the balance to pay (positive) or reclaim (negative). */
  dueMinor: Money; inputMinor: Money; balanceMinor: Money;
  filing: VatFiling | null;
}
export interface MonthSummary { month: string; revenueMinor: Money; costsMinor: Money; resultMinor: Money; cumulativeMinor: Money; workedMinutes: number; billableMinutes: number; }
export interface YearSummary { year: string; revenueMinor: Money; costsMinor: Money; resultMinor: Money; workedMinutes: number; billableMinutes: number; }
export interface AppState {
  workspace: Workspace; workspaces: Workspace[]; business: BusinessProfile;
  clients: Client[]; projects: Project[]; timeEntries: TimeEntry[]; invoices: Invoice[];
  expenses: Expense[]; payments: Payment[]; creditNotes: CreditNote[]; attachments: Attachment[];
  insights: ProjectInsight[]; timer: Timer | null;
  totals: { revenueMinor: Money; directCostsMinor: Money; generalCostsMinor: Money; outstandingMinor: Money; unbilledMinor: Money; workedMinutes: number; nonBillableMinutes: number; };
  vatPeriods: VatPeriod[]; months: MonthSummary[]; years: YearSummary[];
  capabilities: { issuance: 'NL-domestic-EU-export'; backupVersion: 1; };
}
export interface Upload { name: string; mime: string; base64: string; }
type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type ClientInput = Optional<Pick<Client, 'name' | 'address' | 'country' | 'email' | 'taxId' | 'contactName' | 'registrationId' | 'notes'>, 'contactName' | 'registrationId' | 'notes'>;
export type ProjectInput = { clientId: Id; name: string; kind: Project['kind']; rate: string; fixedPrice: string | null; costsComplete: boolean; status: ProjectStatus; estimatedRemainingMinutes: number | null; notes?: string; };
export type TimeInput = { projectId: Id; date: string; minutes: number; description: string; category: string; billable: boolean; approved: boolean; startTime?: string | null; endTime?: string | null; notes?: string; };
export type DraftInput = { projectId: Id; timeEntryIds: Id[]; issueDate: string; supplyDate: string; dueDate: string; taxRate: string; notes: string; extraLines: { description: string; quantity: string; unitPrice: string; taxRate: string; }[]; currency?: string; exchangeRate?: string; };
export type ExpenseInput = { projectId: Id | null; date: string; description: string; netAmount: string; taxAmount: string; deductibleTax: boolean; supplier?: string; supplierInvoiceNumber?: string; category?: string; country?: string; vatTreatment?: ExpenseVat; paymentMethod?: string; notes?: string; originalCurrency?: string; originalAmount?: string | null; };
export type Command =
  | { type: 'client.create'; data: ClientInput }
  | { type: 'client.update'; data: ClientInput & { id: Id; revision: number } }
  | { type: 'project.create'; data: ProjectInput }
  | { type: 'project.update'; data: ProjectInput & { id: Id; revision: number } }
  | { type: 'time.create'; data: TimeInput }
  | { type: 'time.update'; data: TimeInput & { id: Id; revision: number } }
  | { type: 'time.delete'; data: { id: Id; revision: number } }
  | { type: 'invoice.draft'; data: DraftInput }
  | { type: 'invoice.issue'; data: { id: Id; revision: number } }
  | { type: 'invoice.deleteDraft'; data: { id: Id; revision: number } }
  | { type: 'payment.create'; data: { invoiceId: Id; date: string; amount: string; reference: string } }
  | { type: 'payment.reverse'; data: { id: Id; date: string; reason: string } }
  | { type: 'credit.create'; data: { invoiceId: Id; date: string; netAmount: string; reason: string } }
  | { type: 'expense.create'; data: ExpenseInput & { attachment: Upload | null } }
  | { type: 'expense.update'; data: ExpenseInput & { id: Id; revision: number } }
  | { type: 'expense.delete'; data: { id: Id; revision: number } }
  | { type: 'business.update'; data: Optional<Omit<BusinessProfile, 'logoId' | 'nextInvoiceNumber'>, 'vatFrequency' | 'smallBusinessScheme'> & { nextInvoiceNumber?: number; logo?: Upload | null } }
  | { type: 'vat.filing'; data: VatFiling }
  | { type: 'workspace.create'; data: { name: string; currency: string; demo: boolean } }
  | { type: 'workspace.switch'; data: { id: Id } }
  | { type: 'backup.restore'; data: { name: string; base64: string } }
  | { type: 'timer.start'; data: Omit<Timer, 'startedAt'> }
  | { type: 'timer.stop'; data: { minutes: number; date: string; approved: boolean } };
export interface CommandEnvelope { requestId: string; workspaceId: Id; command: Command; }
export interface CommandResult { state: AppState; createdId?: Id; message?: string; }
export interface ApiError { error: string; code: string; details?: unknown; }

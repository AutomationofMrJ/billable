import { COUNTRY_CODES, CURRENCY_CODES, OTHER_COUNTRY } from '../shared/geo';
export function money(minor: number | null, currency = 'EUR'): string {
  if (minor === null) return '—';
  // Every amount is stored with two decimals, so currencies with 0 or 3 decimals still show exactly two.
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
}
export function decimal(minor: number): string { return (minor / 100).toFixed(2); }
export function hours(minutes: number): string { return `${Number((minutes / 60).toFixed(2))}h`; }
export function duration(minutes: number): string { return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
export function date(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function localDate(day: Date): string { return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; }
export function today(): string { return localDate(new Date()); }
export function dueDate(): string { const day = new Date(); day.setDate(day.getDate() + 30); return localDate(day); }
export function bytes(size: number): string { return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
const regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region', fallback: 'code' });
const currencyNames = new Intl.DisplayNames(['en-GB'], { type: 'currency', fallback: 'code' });
const byName = (a: string[], b: string[]) => a[1].localeCompare(b[1], 'en-GB');
/** Every ISO country as [code, English name], sorted by name. */
export const countries = COUNTRY_CODES.map(code => [code, regionNames.of(code) || code]).sort(byName);
/** Every active ISO currency as [code, English name], sorted by code. */
// Older ICU data lacks names for the newest codes.
const newerCurrencies: Record<string, string> = { SLE: 'Sierra Leonean Leone', ZWG: 'Zimbabwe Gold', VES: 'Venezuelan Bolívar' };
const currencyLabel = (code: string) => { const name = currencyNames.of(code); return !name || name === code ? newerCurrencies[code] ?? code : name; };
export const currencies = CURRENCY_CODES.map(code => [code, currencyLabel(code)]);
/** ZZ is the stored code for “other / not listed”; it is not printed on documents. */
export function country(code: string): string { return !code || code === OTHER_COUNTRY ? '' : regionNames.of(code) || code; }
export function currencyName(code: string): string { return currencyLabel(code); }
export const statusLabels: Record<string, string> = { quote: 'Quote', active: 'In progress', paused: 'Paused', complete: 'Completed', cancelled: 'Cancelled' };
export const expenseVatLabels: Record<string, string> = { standard: 'VAT charged by the supplier', none: 'No VAT (exempt, bank fees, private seller)', 'reverse-domestic': 'Reverse charge · domestic (e.g. subcontractor)', 'import-non-eu': 'Reverse charge · supplier outside the EU', 'intra-eu': 'Reverse charge · supplier in another EU country' };

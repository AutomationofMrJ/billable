import Decimal from 'decimal.js';

/** Maximum stored monetary amount, in the workspace's two-decimal minor units. */
export const MAX_MONEY = 100_000_000_000;

// A private constructor prevents another module from changing this core's rounding.
const Exact = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

function minor(value: number, label: string, signed = false): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer in minor units.`);
  if (Math.abs(value) > MAX_MONEY || (!signed && value < 0)) {
    throw new RangeError(`${label} is outside the supported monetary range.`);
  }
  return value;
}

function decimal(input: string, places: number, label: string): Decimal {
  if (typeof input !== 'string') throw new TypeError(`${label} must be a decimal string.`);
  const value = input.trim();
  if (value.length > 64 || !new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(value)) {
    throw new TypeError(`${label} must be nonnegative, with at most ${places} decimal places.`);
  }
  return new Exact(value);
}

function minutes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Minutes must be a nonnegative safe integer.');
  }
  return value;
}

function result(value: Decimal, limit = MAX_MONEY): number {
  const rounded = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (!rounded.isFinite() || rounded.abs().greaterThan(limit)) {
    throw new RangeError('Calculated amount exceeds the supported monetary range.');
  }
  // Zero has one canonical representation; reversals must not introduce -0.
  const amount = rounded.isZero() ? 0 : rounded.toNumber();
  if (!Number.isSafeInteger(amount)) throw new RangeError('Calculated amount is not a safe integer.');
  return amount;
}

/** Parse user-entered major units. No exponents, locale separators or silent cent rounding. */
export function money(input: string): number {
  return result(decimal(input, 2, 'Amount').times(100));
}

/** Round tax separately on each invoice line; percentages have at most three decimals. */
export function tax(netMinor: number, rate: string): number {
  minor(netMinor, 'Net amount');
  const percentage = decimal(rate, 3, 'Tax percentage');
  if (percentage.greaterThan(100)) throw new RangeError('Tax percentage must be at most 100.');
  return result(new Exact(netMinor).times(percentage).dividedBy(100));
}

/** Decimal quantities have at most six places. The line is rounded once to minor units. */
export function lineAmount(quantity: string, unitMinor: number): number {
  minor(unitMinor, 'Unit price');
  return result(decimal(quantity, 6, 'Quantity').times(unitMinor));
}

/** Calculate directly from integer minutes; never round hours before calculating money. */
export function timeAmount(workedMinutes: number, rateMinor: number): number {
  minutes(workedMinutes);
  minor(rateMinor, 'Hourly rate');
  return result(new Exact(workedMinutes).times(rateMinor).dividedBy(60));
}

/** Signed direct contribution per hour; no worked time means the metric is unknown. */
export function perHour(amountMinor: number, workedMinutes: number): number | null {
  minor(amountMinor, 'Amount', true);
  minutes(workedMinutes);
  if (workedMinutes === 0) return null;
  // This is a derived display metric: one minute can imply 60 times a stored amount.
  return result(new Exact(amountMinor).times(60).dividedBy(workedMinutes), 60 * MAX_MONEY);
}

/** Exchange rates mean “1 unit of the workspace currency = rate units of the document currency”. */
function exchangeRate(rate: string): Decimal {
  const value = decimal(rate, 6, 'Exchange rate');
  if (value.isZero() || value.greaterThan(1_000_000)) throw new RangeError('Exchange rate must be above 0 and at most 1,000,000.');
  return value;
}
/** Converts a workspace-currency amount into the document currency, rounded once. */
export function toDocument(baseMinor: number, rate: string): number {
  minor(baseMinor, 'Amount', true);
  return result(new Exact(baseMinor).times(exchangeRate(rate)));
}
/** Converts a document-currency amount back into the workspace currency, rounded once. */
export function toBase(documentMinor: number, rate: string): number {
  minor(documentMinor, 'Amount', true);
  return result(new Exact(documentMinor).dividedBy(exchangeRate(rate)));
}

/** Signed values support reversals; validate the complete total without float accumulation. */
export function sumMoney(values: readonly number[]): number {
  if (!Array.isArray(values)) throw new TypeError('Amounts must be an array of minor units.');
  let total = new Exact(0);
  for (const value of values) total = total.plus(minor(value, 'Amount', true));
  return result(total);
}

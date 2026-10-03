import assert from 'node:assert/strict';
import test from 'node:test';
import Decimal from 'decimal.js';
import { MAX_MONEY, lineAmount, money, perHour, sumMoney, tax, timeAmount } from '../shared/money.js';

test('money parses exact cents and the supported boundary without float drift', () => {
  assert.equal(money('0'), 0);
  assert.equal(money('0.29'), 29);
  assert.equal(money('12.3'), 1230);
  assert.equal(money(' 0012.30 '), 1230);
  assert.equal(money('1000000000.00'), MAX_MONEY);
  assert.throws(() => money('1000000000.01'), RangeError);
});

test('money rejects negative, ambiguous and over-precise inputs instead of silently rounding', () => {
  for (const input of ['-1', '+1', '1.001', '1e3', '1,20', '1,000.00', 'NaN', 'Infinity', '', '.50', '1.']) {
    assert.throws(() => money(input), TypeError, input);
  }
  assert.throws(() => money(10 as unknown as string), TypeError);
  assert.throws(() => money('0'.repeat(65)), TypeError);
});

test('tax rounds cent ties HALF_UP, accepts fractional percentages and preserves line rounding', () => {
  assert.equal(tax(50, '21'), 11);
  assert.equal(tax(1, '50'), 1);
  assert.equal(tax(12_345, '7.125'), 880);
  assert.equal(tax(MAX_MONEY, '100'), MAX_MONEY);
  assert.equal(tax(1, '0'), 0);
  assert.equal(sumMoney([tax(2, '21'), tax(2, '21')]), 0);
  assert.equal(tax(4, '21'), 1, 'Tax is explicitly rounded by line, not reconstructed from the total.');
  for (const rate of ['-1', '100.001', '1.0001', '1e1']) assert.throws(() => tax(100, rate));
  assert.throws(() => tax(-1, '21'), RangeError);
});

test('line amounts use decimal quantities and reject overflowing or unsafe prices', () => {
  assert.equal(lineAmount('0.29', 100), 29);
  assert.equal(lineAmount('1.5', 101), 152);
  assert.equal(lineAmount('0.000001', 500_000), 1);
  assert.equal(lineAmount('0', MAX_MONEY), 0);
  assert.equal(lineAmount('1', MAX_MONEY), MAX_MONEY);
  assert.throws(() => lineAmount('1.000001', MAX_MONEY), RangeError);
  assert.throws(() => lineAmount('0.0000001', 100), TypeError);
  assert.throws(() => lineAmount('-1', 100), TypeError);
  assert.throws(() => lineAmount('1', 1.5), TypeError);
  assert.throws(() => lineAmount('1', Number.MAX_SAFE_INTEGER + 1), TypeError);
});

test('time is valued from exact minutes without first rounding hours', () => {
  assert.equal(timeAmount(1, 10_000), 167);
  assert.equal(timeAmount(59, 10_000), 9833);
  assert.equal(timeAmount(3, 10), 1, 'A half-cent rounds upward.');
  assert.equal(timeAmount(0, MAX_MONEY), 0);
  assert.equal(timeAmount(60, MAX_MONEY), MAX_MONEY);
  assert.throws(() => timeAmount(61, MAX_MONEY), RangeError);
  for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => timeAmount(value, 100), TypeError);
  }
});

test('per-hour contribution includes every worked minute and keeps loss or missing time meaningful', () => {
  assert.equal(perHour(money('2400') - money('300'), 20 * 60), money('105'));
  assert.equal(perHour(money('3000') - money('500'), 50 * 60), money('50'));
  assert.equal(perHour(-1, 120), -1, 'A negative half-cent rounds away from zero.');
  assert.equal(perHour(0, 60), 0);
  assert.equal(perHour(100, 0), null);
  assert.equal(perHour(MAX_MONEY, 1), 60 * MAX_MONEY);
  assert.throws(() => perHour(100, -1), TypeError);
});

test('sums support payment reversals and credits with exact final range validation', () => {
  assert.equal(sumMoney([]), 0);
  assert.equal(sumMoney([29, 1, -10]), 20);
  assert.equal(sumMoney([MAX_MONEY, MAX_MONEY, -MAX_MONEY]), MAX_MONEY);
  assert.equal(sumMoney([-MAX_MONEY]), -MAX_MONEY);
  assert.throws(() => sumMoney([MAX_MONEY, 1]), RangeError);
  assert.throws(() => sumMoney([-MAX_MONEY, -1]), RangeError);
  assert.throws(() => sumMoney([0.1]), TypeError);
  assert.throws(() => sumMoney([MAX_MONEY + 1]), RangeError);
  assert.equal(Object.is(sumMoney([-0]), -0), false);
});

test('external decimal configuration cannot alter money rounding', () => {
  const prior = Decimal.rounding;
  try {
    Decimal.set({ rounding: Decimal.ROUND_DOWN });
    assert.equal(tax(1, '50'), 1);
    assert.equal(lineAmount('1.5', 101), 152);
  } finally {
    Decimal.set({ rounding: prior });
  }
});

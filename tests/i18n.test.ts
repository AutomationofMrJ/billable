import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectKeys, src } from './i18n-keys';

const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort().join();

test('every language translates every interface text with the same placeholders', () => {
  const { keys } = collectKeys();
  assert.ok(keys.length > 500, 'expected the interface text to be extracted');
  const locales = readdirSync(join(src, 'locales')).filter(name => name.endsWith('.json'));
  const offered = [...readFileSync(join(src, 'i18n.ts'), 'utf8').matchAll(/code: '([a-z]{2})'/g)]
    .map(match => match[1]).filter(code => code !== 'en').map(code => `${code}.json`).sort();
  assert.equal(locales.length, 22, 'expected the 22 available non-English translations');
  assert.deepEqual(locales.sort(), offered, 'each offered language must have exactly one translation file');
  for (const name of locales) {
    const dictionary = JSON.parse(readFileSync(join(src, 'locales', name), 'utf8')) as Record<string, string>;
    const missing = keys.filter(key => !dictionary[key]?.trim());
    assert.deepEqual(missing, [], `${name} is missing translations`);
    const extra = Object.keys(dictionary).filter(key => !keys.includes(key));
    assert.deepEqual(extra, [], `${name} has translations for text that no longer exists`);
    for (const key of keys) assert.equal(placeholders(dictionary[key]), placeholders(key), `${name}: placeholders differ for “${key}”`);
  }
});

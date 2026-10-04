/** Interface language: English source text is the key; each locale file maps it to a translation. */
export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-GB' },
  { code: 'bg', name: 'Български', locale: 'bg-BG' },
  { code: 'cs', name: 'Čeština', locale: 'cs-CZ' },
  { code: 'da', name: 'Dansk', locale: 'da-DK' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'et', name: 'Eesti', locale: 'et-EE' },
  { code: 'el', name: 'Ελληνικά', locale: 'el-GR' },
  { code: 'es', name: 'Español', locale: 'es-ES' },
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
  { code: 'hr', name: 'Hrvatski', locale: 'hr-HR' },
  { code: 'it', name: 'Italiano', locale: 'it-IT' },
  { code: 'lv', name: 'Latviešu', locale: 'lv-LV' },
  { code: 'lt', name: 'Lietuvių', locale: 'lt-LT' },
  { code: 'hu', name: 'Magyar', locale: 'hu-HU' },
  { code: 'mt', name: 'Malti', locale: 'mt-MT' },
  { code: 'nl', name: 'Nederlands', locale: 'nl-NL' },
  { code: 'pl', name: 'Polski', locale: 'pl-PL' },
  { code: 'pt', name: 'Português', locale: 'pt-PT' },
  { code: 'ro', name: 'Română', locale: 'ro-RO' },
  { code: 'sk', name: 'Slovenčina', locale: 'sk-SK' },
  { code: 'sl', name: 'Slovenščina', locale: 'sl-SI' },
  { code: 'fi', name: 'Suomi', locale: 'fi-FI' },
  { code: 'sv', name: 'Svenska', locale: 'sv-SE' },
] as const;
export type LanguageCode = typeof LANGUAGES[number]['code'];

const STORAGE_KEY = 'billable.language';
const loaders = import.meta.glob<{ default: Record<string, string> }>('./locales/*.json');
let dictionary: Record<string, string> = {};
let current: LanguageCode = 'en';

/** Translates English source text; {0}, {1}… are replaced by the extra arguments. Unknown text stays English. */
export function t(text: string, ...args: (string | number | null | undefined)[]): string {
  const template = dictionary[text] || text;
  return args.length ? template.replace(/\{(\d+)\}/g, (match, index) => (Number(index) < args.length ? String(args[Number(index)] ?? "") : match)) : template;
}
/** Marks text for translation where it is stored first and translated later with t(). */
export const msg = (text: string) => text;

export const language = () => current;
/** BCP 47 locale for Intl number, date and country formatting. */
export const locale = () => LANGUAGES.find(entry => entry.code === current)!.locale;

function stored(): string | null { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } }
/** Loads the saved language before the interface modules render their text. */
export async function initLanguage(): Promise<void> {
  const code = stored();
  const entry = LANGUAGES.find(item => item.code === code);
  const load = entry && entry.code !== 'en' ? loaders[`./locales/${entry.code}.json`] : undefined;
  if (entry && load) {
    try { dictionary = (await load()).default; current = entry.code; } catch { dictionary = {}; current = 'en'; }
  }
  document.documentElement.lang = current;
}
/** Saves the choice and reloads, so every label, list and number format switches together. Your data is not touched. */
export function setLanguage(code: LanguageCode): void {
  // Without browser storage the choice could not survive the reload, so the language stays as it is.
  try { localStorage.setItem(STORAGE_KEY, code); } catch { return; }
  window.location.reload();
}

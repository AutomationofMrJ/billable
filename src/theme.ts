/** Light or dark interface. Follows the system setting until the person picks one; printed documents stay light. */
export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'billable.theme';
const listeners = new Set<() => void>();
const media = () => window.matchMedia?.('(prefers-color-scheme: dark)');

function saved(): Theme | null {
  try { const value = localStorage.getItem(STORAGE_KEY); return value === 'light' || value === 'dark' ? value : null; } catch { return null; }
}
function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141a17' : '#245a43');
  listeners.forEach(listener => listener());
}
export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
export function initTheme(): void {
  apply(saved() ?? (media()?.matches ? 'dark' : 'light'));
  media()?.addEventListener?.('change', event => { if (!saved()) apply(event.matches ? 'dark' : 'light'); });
}
export function setTheme(theme: Theme): void {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* The choice then lasts for this visit only. */ }
  apply(theme);
}
/** For useSyncExternalStore. */
export function subscribeTheme(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertCircle, CheckCircle2, Clock3, FileText, FolderOpen, HardDriveDownload, LayoutDashboard, Menu, Receipt, RefreshCw, Search, Settings2, ShieldCheck, X, ChevronDown, ArrowUpRight, ChartColumn, CircleHelp, Languages, Moon, Sun } from 'lucide-react';
import { BRAND, type AppState, type Command } from '../shared/types';
import { getState, RequestError, sendCommand } from './api';
import { ActiveModal } from './forms';
import { ExpensesPage, InvoicesPage, Overview, ProjectsPage, ReportsPage, TimePage, type ModalName, type RunOptions } from './pages';
import { Button, ErrorBoundary } from './components';
import { HelpGuide } from './help';
import { LANGUAGES, language, msg, setLanguage, t, type LanguageCode } from './i18n';
import { currentTheme, setTheme, subscribeTheme } from './theme';

// `name` is the internal page key used across the app; `label` and `search` are display text.
const navigation = [
  { name: 'Overview', path: '', icon: LayoutDashboard, label: msg('Overview') },
  { name: 'Time', path: 'time', icon: Clock3, label: msg('Time'), search: msg('Search time') },
  { name: 'Projects', path: 'projects', icon: FolderOpen, label: msg('Projects'), search: msg('Search projects') },
  { name: 'Invoices', path: 'invoices', icon: FileText, label: msg('Invoices'), search: msg('Search invoices') },
  { name: 'Expenses', path: 'expenses', icon: Receipt, label: msg('Expenses'), search: msg('Search expenses') },
  { name: 'Reports', path: 'reports', icon: ChartColumn, label: msg('Reports') },
];
/** /invoices/<id> and /projects/<id> open a record; anything unknown falls back to Overview. */
function routeFrom(pathname: string) {
  const [segment = '', id] = pathname.split('/').filter(Boolean);
  const entry = navigation.find(item => item.path === segment) ?? navigation[0];
  const record = id && (entry.name === 'Invoices' || entry.name === 'Projects') ? decodeURIComponent(id) : null;
  return { page: entry.name, invoice: entry.name === 'Invoices' ? record : null, project: entry.name === 'Projects' ? record : null };
}
const initialRoute = routeFrom(window.location.pathname);

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState(initialRoute.page);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [modal, setModal] = useState<{ type: ModalName; id?: string; projectId?: string } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(initialRoute.invoice);
  const [selectedProject, setSelectedProject] = useState<string | null>(initialRoute.project);
  const [mobileOpen, setMobileOpen] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const operation = useRef(false);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const stateRef = useRef(state);
  stateRef.current = state;
  // The next URL change replaces the history entry instead of adding one (first render, stale record links).
  const replaceRoute = useRef(true);
  // Kept only after an attempt without a response, so resubmitting the same change replays it instead of duplicating it.
  const retry = useRef<{ key: string; requestId: string } | null>(null);
  const current = navigation.find(item => item.name === page) ?? navigation[0];
  const path = `/${[current.path, page === 'Invoices' ? selectedInvoice : page === 'Projects' ? selectedProject : null].filter(Boolean).map(part => encodeURIComponent(part!)).join('/')}`;
  useEffect(() => {
    if (window.location.pathname !== path) {
      if (replaceRoute.current) window.history.replaceState(null, '', path); else window.history.pushState(null, '', path);
    }
    replaceRoute.current = false;
  }, [path]);
  useEffect(() => {
    const back = () => { const route = routeFrom(window.location.pathname); setPage(route.page); setSelectedInvoice(route.invoice); setSelectedProject(route.project); setSearch(''); setMobileOpen(false); };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => { document.title = `${t(current.label)} · ${BRAND.name}`; }, [current.label]);
  useEffect(() => {
    // A bookmarked record from another workspace (or a deleted one) opens the list instead.
    if (!state) return;
    if (selectedInvoice && !state.invoices.some(invoice => invoice.id === selectedInvoice)) { replaceRoute.current = true; setSelectedInvoice(null); }
    if (selectedProject && !state.projects.some(project => project.id === selectedProject)) { replaceRoute.current = true; setSelectedProject(null); }
  }, [state, selectedInvoice, selectedProject]);
  const load = useCallback(async () => {
    try {
      const next = await getState(); const previous = stateRef.current;
      if (previous && previous.workspace.id !== next.workspace.id) { setSelectedInvoice(null); setSelectedProject(null); setNotice({ text: t('Another window opened “{0}”. You are now viewing that workspace; nothing was saved to the previous one.', next.workspace.name), error: true }); }
      setState(next); setLoadError('');
    } catch (error) { setLoadError(error instanceof Error ? t(error.message) : t('Could not reach your local workspace.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const focus = () => { if (!operation.current && !modalRef.current) void load(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [load]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timeout = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  const close = useCallback(() => { if (!operation.current) setModal(null); }, []);
  const open = useCallback((type: ModalName, id?: string, projectId?: string) => { if (!operation.current) { setModal({ type, id, projectId }); setNotice(null); } }, []);
  const navigate = (next: string) => { setPage(next); setSearch(''); setMobileOpen(false); setSelectedProject(null); if (next !== 'Invoices') setSelectedInvoice(null); window.scrollTo({ top: 0 }); };
  async function run(command: Command, options: RunOptions = {}) {
    if (!state || operation.current) return null;
    operation.current = true; setBusy(true); setNotice(null);
    const key = JSON.stringify([state.workspace.id, command]);
    const requestId = retry.current?.key === key ? retry.current.requestId : crypto.randomUUID();
    try {
      const result = await sendCommand(state.workspace.id, command, requestId);
      retry.current = null;
      const switched = result.state.workspace.id !== state.workspace.id;
      if (switched) { setSelectedInvoice(null); setSelectedProject(null); setSearch(''); setPage('Overview'); }
      const message = result.message ? t(result.message) : successMessage(command);
      setState(result.state); setNotice({ text: switched ? t('{0} You are now in “{1}”.', message, result.state.workspace.name) : message, error: false });
      return result;
    } catch (error) {
      retry.current = error instanceof RequestError && error.status === 0 ? { key, requestId } : null;
      // Show the newer saved state without discarding the open form; edit forms then flag what changed.
      if (error instanceof RequestError && error.status === 409) await load();
      const text = error instanceof RequestError && error.code === 'REVISION_CONFLICT' ? t('This record was changed in another tab or window. The latest version is loaded; check it and save again if your change still applies.') : error instanceof Error ? t(error.message) : t('Could not save this change. Please try again.');
      if (options.inline) throw new Error(text);
      setNotice({ text, error: true });
      return null;
    } finally { operation.current = false; setBusy(false); }
  }
  if (!state) return <div className="startup"><BrandMark/><h1>{BRAND.name}</h1><p>{loadError ? t('Your local workspace is waiting.') : t('Opening your local ledger…')}</p>{loadError ? <><p className="startup-error" role="alert">{loadError}</p><p className="muted">{t('Check that the Billable server is running, then reconnect.')}</p><Button icon={RefreshCw} onClick={() => void load()}>{t('Reconnect')}</Button></> : <div className="loading-line"/>}</div>;
  const pageProps = { state, open, run, busy, search, navigate, selectedInvoice, selectInvoice: setSelectedInvoice, selectedProject, selectProject: setSelectedProject };
  const toMain = (event: React.MouseEvent) => { event.preventDefault(); document.getElementById('main')?.focus(); };
  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={toMain}>{t('Skip to content')}</a>
    {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)}/>}
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}><div className="brand"><BrandMark/><div><strong>{BRAND.name}</strong><span>{t('A little clarity.')}</span></div><button className="icon-button mobile-close" aria-label={t('Close navigation')} onClick={() => setMobileOpen(false)}><X size={20}/></button></div><button className="workspace-switch" onClick={() => open('workspace')}><span className="workspace-avatar">{state.workspace.demo ? 'D' : state.workspace.name[0]}</span><span><strong>{state.workspace.name}</strong><small>{state.workspace.demo ? t('Fictional demo') : t('Your administration')}</small></span><ChevronDown size={15}/></button><div className="nav-label">{t('YOUR WORKBOOK')}</div><nav aria-label={t('Main navigation')}>{navigation.map(({ name, label, icon: Icon }) => <button key={name} aria-current={page === name ? 'page' : undefined} className={page === name ? 'active' : ''} onClick={() => navigate(name)}><Icon size={19} strokeWidth={1.6}/><span>{t(label)}</span>{page === name && <span className="nav-dot"/>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-caption"><span className="eyebrow">{t('Built around your work')}</span><p>{t('Less admin.')}<br/>{t('More perspective.')}</p><div className="caption-rule"/></div><button className="secondary-nav" onClick={() => open('workspace')}><HardDriveDownload size={18} strokeWidth={1.6}/>{' '}{t('Workspace & backup')}</button><button className="secondary-nav" onClick={() => open('settings')}><Settings2 size={18} strokeWidth={1.6}/>{' '}{t('Business settings')}</button><label className="language-picker"><Languages size={18} strokeWidth={1.6} aria-hidden="true"/><span className="sr-only">{t('Language')}</span><select value={language()} onChange={event => setLanguage(event.target.value as LanguageCode)}>{LANGUAGES.map(entry => <option key={entry.code} value={entry.code} lang={entry.code}>{entry.name}</option>)}</select><ChevronDown size={14} aria-hidden="true"/></label><div className="local-label"><ShieldCheck size={14}/><span>{t('Stored on this computer')}</span><i/></div></div></aside>
    <div className="app-main"><header className="app-header"><div className="header-breadcrumb"><button className="icon-button mobile-menu" aria-label={t('Open navigation')} onClick={() => setMobileOpen(true)}><Menu size={20}/></button><span>{t('Workspace')}</span><span className="breadcrumb-divider">/</span><strong>{t(current.label)}</strong></div><div className="header-right">{current.search && !selectedInvoice && !selectedProject && <label className="search"><Search size={16}/><input type="search" aria-label={t(current.search)} placeholder={`${t(current.search)}…`} value={search} onChange={event => setSearch(event.target.value)}/><kbd>⌕</kbd></label>}<span className={`workspace-tag ${state.workspace.demo ? 'demo' : ''}`}><span/>{state.workspace.demo ? t('DEMO WORKSPACE') : t('LOCAL WORKSPACE')}</span><button className="icon-button header-tool" aria-label={t('How Billable works')} title={t('How Billable works')} onClick={() => setHelpOpen(true)}><CircleHelp size={19} strokeWidth={1.7}/></button><button className="icon-button header-tool" aria-label={theme === 'dark' ? t('Switch to light mode') : t('Switch to dark mode')} title={theme === 'dark' ? t('Switch to light mode') : t('Switch to dark mode')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={19} strokeWidth={1.7}/> : <Moon size={19} strokeWidth={1.7}/>}</button><button className="header-avatar" aria-label={t('Business settings')} onClick={() => open('settings')}>{state.business.name[0] || 'B'}</button></div></header>
      <main className="main-content" id="main" tabIndex={-1}>{state.workspace.demo && <div className="demo-banner"><span>{t('Made-up clients. Real perspective.')}</span><span>{t('You’re exploring fictional demo data.')}<button onClick={() => open('workspace')}>{t('Start your own workspace')}{' '}<ArrowUpRight size={13}/></button></span></div>}{loadError && <div className="notice amber" role="alert">{loadError} <button className="text-link" onClick={() => void load()}>{t('Reconnect')}</button></div>}<ErrorBoundary key={page} onReset={() => navigate('Overview')}>{page === 'Overview' && <Overview {...pageProps}/>}{page === 'Time' && <TimePage {...pageProps}/>}{page === 'Projects' && <ProjectsPage {...pageProps}/>}{page === 'Invoices' && <InvoicesPage {...pageProps}/>}{page === 'Expenses' && <ExpensesPage {...pageProps}/>}{page === 'Reports' && <ReportsPage {...pageProps}/>}</ErrorBoundary><footer className="app-footer"><span>{BRAND.name} · {t(BRAND.tagline)}</span><span>{t('Local first. A clear ledger.')}</span></footer></main>
    </div>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}<span>{notice.text}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label={t('Dismiss message')}><X size={15}/></button></div>}
    {helpOpen && <HelpGuide onClose={() => setHelpOpen(false)} navigate={navigate} open={type => open(type)}/>}
    {modal && <ActiveModal key={`${modal.type}-${modal.id || ''}-${state.workspace.id}`} type={modal.type} id={modal.id} projectId={modal.projectId} state={state} run={run} busy={busy} onClose={close} open={open} onInvoice={id => { navigate('Invoices'); setSelectedInvoice(id); }}/>}
  </div>;
}
// Listed so the extraction script finds text that is shown through a variable.
msg('Know what your work is worth.');
function BrandMark() { return <svg className="brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect width="36" height="36" rx="10" fill="currentColor"/><path d="M11 9H19.5C24 9 26 11.5 26 15C26 17.5 24.8 19.2 22.8 20C25 20.8 26 22.4 26 24.8C26 27.6 23.8 29 20 29H11V9Z" fill="#F6F3EB"/><path d="M16 14H19.5C20.8 14 21.5 14.6 21.5 15.7C21.5 16.8 20.8 17.5 19.5 17.5H16V14ZM16 22H20C21.2 22 21.8 22.6 21.8 23.5C21.8 24.5 21.2 25 20 25H16V22Z" fill="currentColor"/><path d="M9 29L29 9" stroke="#F6F3EB" strokeWidth="1.1"/></svg>; }
function successMessage(command: Command) {
  if (command.type === 'expense.create') return command.data.attachment ? t('Expense and original attachment saved.') : t('Expense saved without an attachment.');
  if (command.type === 'timer.stop' && !command.data.approved) return t('Time saved under “Needs review”. It counts once you approve it.');
  if (command.type === 'time.create' && !command.data.approved) return t('Saved as a proposal under “Needs review”.');
  const messages: Partial<Record<Command['type'], string>> = { 'client.create': t('Client added.'), 'client.update': t('Client details saved.'), 'project.create': t('Project created.'), 'project.update': t('Project saved.'), 'time.create': t('Time added to your ledger.'), 'time.update': t('Time updated.'), 'time.delete': t('Time entry deleted.'), 'invoice.draft': t('Draft created. Ready for your review.'), 'invoice.issue': t('Invoice issued and safely preserved.'), 'invoice.deleteDraft': t('Draft deleted. Its time is available again.'), 'payment.create': t('Payment recorded.'), 'payment.reverse': t('Payment reversal recorded.'), 'credit.create': t('Credit note recorded.'), 'expense.update': t('Expense updated.'), 'expense.delete': t('Expense deleted.'), 'vat.filing': t('VAT return status saved.'), 'backup.restore': t('Backup restored into a new workspace.'), 'timer.start': t('Timer started. A little focus goes a long way.'), 'timer.stop': t('Actual work confirmed and saved.'), 'workspace.create': t('Your workspace is ready.'), 'workspace.switch': t('Workspace opened.'), 'business.update': t('Business details saved.') };
  return messages[command.type] || t('Your change is saved.');
}

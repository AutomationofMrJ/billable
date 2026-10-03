import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, FileText, FolderOpen, HardDriveDownload, LayoutDashboard, Menu, Receipt, RefreshCw, Search, Settings2, ShieldCheck, X, ChevronDown, ArrowUpRight, ChartColumn } from 'lucide-react';
import { BRAND, type AppState, type Command } from '../shared/types';
import { getState, RequestError, sendCommand } from './api';
import { ActiveModal } from './forms';
import { ExpensesPage, InvoicesPage, Overview, ProjectsPage, ReportsPage, TimePage, type ModalName, type RunOptions } from './pages';
import { Button } from './components';

const navigation = [{ name: 'Overview', icon: LayoutDashboard }, { name: 'Time', icon: Clock3 }, { name: 'Projects', icon: FolderOpen }, { name: 'Invoices', icon: FileText }, { name: 'Expenses', icon: Receipt }, { name: 'Reports', icon: ChartColumn }];
export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState('Overview');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [modal, setModal] = useState<{ type: ModalName; id?: string; projectId?: string } | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const operation = useRef(false);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Kept only after an attempt without a response, so resubmitting the same change replays it instead of duplicating it.
  const retry = useRef<{ key: string; requestId: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await getState(); const previous = stateRef.current;
      if (previous && previous.workspace.id !== next.workspace.id) { setSelectedInvoice(null); setSelectedProject(null); setNotice({ text: `Another window opened “${next.workspace.name}”. You are now viewing that workspace; nothing was saved to the previous one.`, error: true }); }
      setState(next); setLoadError('');
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'Could not reach your local workspace.'); }
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
      const message = result.message || successMessage(command);
      setState(result.state); setNotice({ text: switched ? `${message} You are now in “${result.state.workspace.name}”.` : message, error: false });
      return result;
    } catch (error) {
      retry.current = error instanceof RequestError && error.status === 0 ? { key, requestId } : null;
      // Show the newer saved state without discarding the open form; edit forms then flag what changed.
      if (error instanceof RequestError && error.status === 409) await load();
      const text = error instanceof RequestError && error.code === 'REVISION_CONFLICT' ? 'This record was changed in another tab or window. The latest version is loaded; check it and save again if your change still applies.' : error instanceof Error ? error.message : 'Could not save this change. Please try again.';
      if (options.inline) throw new Error(text);
      setNotice({ text, error: true });
      return null;
    } finally { operation.current = false; setBusy(false); }
  }
  if (!state) return <div className="startup"><BrandMark/><h1>{BRAND.name}</h1><p>{loadError ? 'Your local workspace is waiting.' : 'Opening your local ledger…'}</p>{loadError ? <><p className="startup-error" role="alert">{loadError}</p><p className="muted">Check that the Billable server is running, then reconnect.</p><Button icon={RefreshCw} onClick={() => void load()}>Reconnect</Button></> : <div className="loading-line"/>}</div>;
  const pageProps = { state, open, run, busy, search, navigate, selectedInvoice, selectInvoice: setSelectedInvoice, selectedProject, selectProject: setSelectedProject };
  return <div className="app-shell">
    {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)}/>}
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}><div className="brand"><BrandMark/><div><strong>{BRAND.name}</strong><span>A little clarity.</span></div><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={20}/></button></div><button className="workspace-switch" onClick={() => open('workspace')}><span className="workspace-avatar">{state.workspace.demo ? 'D' : state.workspace.name[0]}</span><span><strong>{state.workspace.name}</strong><small>{state.workspace.demo ? 'Fictional demo' : 'Your administration'}</small></span><ChevronDown size={15}/></button><div className="nav-label">YOUR WORKBOOK</div><nav aria-label="Main navigation">{navigation.map(({ name, icon: Icon }) => <button key={name} aria-current={page === name ? 'page' : undefined} className={page === name ? 'active' : ''} onClick={() => navigate(name)}><Icon size={19} strokeWidth={1.6}/><span>{name}</span>{page === name && <span className="nav-dot"/>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-caption"><span className="eyebrow">Built around your work</span><p>Less admin.<br/>More perspective.</p><div className="caption-rule"/></div><button className="secondary-nav" onClick={() => open('workspace')}><HardDriveDownload size={18} strokeWidth={1.6}/> Workspace & backup</button><button className="secondary-nav" onClick={() => open('settings')}><Settings2 size={18} strokeWidth={1.6}/> Business settings</button><div className="local-label"><ShieldCheck size={14}/><span>Stored on this computer</span><i/></div></div></aside>
    <div className="app-main"><header className="app-header"><div className="header-breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={20}/></button><span>Workspace</span><span className="breadcrumb-divider">/</span><strong>{page}</strong></div><div className="header-right">{page !== 'Overview' && page !== 'Reports' && !selectedInvoice && !selectedProject && <label className="search"><Search size={16}/><input type="search" aria-label={`Search ${page.toLowerCase()}`} placeholder={`Search ${page.toLowerCase()}…`} value={search} onChange={event => setSearch(event.target.value)}/><kbd>⌕</kbd></label>}<span className={`workspace-tag ${state.workspace.demo ? 'demo' : ''}`}><span/>{state.workspace.demo ? 'DEMO WORKSPACE' : 'LOCAL WORKSPACE'}</span><button className="header-avatar" aria-label="Business settings" onClick={() => open('settings')}>{state.business.name[0] || 'B'}</button></div></header>
      <main className="main-content">{state.workspace.demo && <div className="demo-banner"><span>Made-up clients. Real perspective.</span><span>You’re exploring fictional demo data.<button onClick={() => open('workspace')}>Start your own workspace <ArrowUpRight size={13}/></button></span></div>}{loadError && <div className="notice amber" role="alert">{loadError} <button className="text-link" onClick={() => void load()}>Reconnect</button></div>}{page === 'Overview' && <Overview {...pageProps}/>} {page === 'Time' && <TimePage {...pageProps}/>} {page === 'Projects' && <ProjectsPage {...pageProps}/>} {page === 'Invoices' && <InvoicesPage {...pageProps}/>} {page === 'Expenses' && <ExpensesPage {...pageProps}/>} {page === 'Reports' && <ReportsPage {...pageProps}/>}<footer className="app-footer"><span>{BRAND.name} · {BRAND.tagline}</span><span>Local first. A clear ledger.</span></footer></main>
    </div>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}<span>{notice.text}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={15}/></button></div>}
    {modal && <ActiveModal key={`${modal.type}-${modal.id || ''}-${state.workspace.id}`} type={modal.type} id={modal.id} projectId={modal.projectId} state={state} run={run} busy={busy} onClose={close} open={open} onInvoice={id => { navigate('Invoices'); setSelectedInvoice(id); }}/>}
  </div>;
}
function BrandMark() { return <svg className="brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect width="36" height="36" rx="10" fill="currentColor"/><path d="M11 9H19.5C24 9 26 11.5 26 15C26 17.5 24.8 19.2 22.8 20C25 20.8 26 22.4 26 24.8C26 27.6 23.8 29 20 29H11V9Z" fill="#F6F3EB"/><path d="M16 14H19.5C20.8 14 21.5 14.6 21.5 15.7C21.5 16.8 20.8 17.5 19.5 17.5H16V14ZM16 22H20C21.2 22 21.8 22.6 21.8 23.5C21.8 24.5 21.2 25 20 25H16V22Z" fill="currentColor"/><path d="M9 29L29 9" stroke="#F6F3EB" strokeWidth="1.1"/></svg>; }
function successMessage(command: Command) {
  if (command.type === 'expense.create') return command.data.attachment ? 'Expense and original attachment saved.' : 'Expense saved without an attachment.';
  if (command.type === 'timer.stop' && !command.data.approved) return 'Time saved under “Needs review”. It counts once you approve it.';
  if (command.type === 'time.create' && !command.data.approved) return 'Saved as a proposal under “Needs review”.';
  const messages: Partial<Record<Command['type'], string>> = { 'client.create': 'Client added.', 'client.update': 'Client details saved.', 'project.create': 'Project created.', 'project.update': 'Project saved.', 'time.create': 'Time added to your ledger.', 'time.update': 'Time updated.', 'time.delete': 'Time entry deleted.', 'invoice.draft': 'Draft created. Ready for your review.', 'invoice.issue': 'Invoice issued and safely preserved.', 'invoice.deleteDraft': 'Draft deleted. Its time is available again.', 'payment.create': 'Payment recorded.', 'payment.reverse': 'Payment reversal recorded.', 'credit.create': 'Credit note recorded.', 'expense.update': 'Expense updated.', 'expense.delete': 'Expense deleted.', 'vat.filing': 'VAT return status saved.', 'backup.restore': 'Backup restored into a new workspace.', 'timer.start': 'Timer started. A little focus goes a long way.', 'timer.stop': 'Actual work confirmed and saved.', 'workspace.create': 'Your workspace is ready.', 'workspace.switch': 'Workspace opened.', 'business.update': 'Business details saved.' };
  return messages[command.type] || 'Your change is saved.';
}

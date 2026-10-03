// Browser demo runtime: runs the real server store (server/store.ts) inside the page and answers the
// UI's /api/* requests without a network. Nothing leaves the browser; data is kept in IndexedDB.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { ZodError } from 'zod';
import { WorkspaceStore, seedDemo } from '../server/store';
import { AppError, envelopeSchema } from '../server/validation';
import type { CommandEnvelope, CommandResult, Workspace } from '../shared/types';
import type Database from './shims/better-sqlite3';
import { files, useSqlJs } from './shims/better-sqlite3';

interface Registry { activeId: string; workspaces: Workspace[] }
const DB_NAME = 'billable-demo', STORE = 'files', REGISTRY = 'registry';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode); const request = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}
const dbPath = (id: string) => `/workspaces/${id}.sqlite`;

class DemoManager {
  registry!: Registry; store!: WorkspaceStore;
  async load() {
    const saved = await tx<Registry>('readonly', s => s.get(REGISTRY));
    if (saved) {
      for (const w of saved.workspaces) { const bytes = await tx<Uint8Array>('readonly', s => s.get(dbPath(w.id))); if (bytes) files.set(dbPath(w.id), bytes); }
      if (files.has(dbPath(saved.activeId))) { this.store?.close(); this.registry = saved; this.store = new WorkspaceStore(dbPath(saved.activeId)); return; }
    }
    const workspace: Workspace = { id: crypto.randomUUID(), name: 'The sample studio', demo: true, currency: 'EUR' };
    this.store = new WorkspaceStore(dbPath(workspace.id), workspace);
    this.store.db.transaction(() => seedDemo(this.store))();
    this.registry = { activeId: workspace.id, workspaces: [workspace] };
    await this.persist();
  }
  async persist() {
    const bytes = (this.store.db as unknown as Database).export();
    files.set(this.store.path, bytes);
    await tx('readwrite', s => { s.put(bytes, this.store.path); s.put(this.registry, REGISTRY); });
    tabs.postMessage('saved');
  }
  state() { return this.store.state(this.registry.workspaces); }
  private open(id: string) { this.store.close(); this.store = new WorkspaceStore(dbPath(id)); }
  async execute(e: CommandEnvelope): Promise<CommandResult> {
    if (e.workspaceId !== this.registry.activeId) throw new AppError('Another tab switched the workspace. Refresh before making changes.', 409, 'WORKSPACE_CHANGED');
    const cmd = e.command;
    if (cmd.type === 'backup.restore') throw new AppError('Restoring a backup needs the local app. This browser demo keeps its data in this browser only.', 422, 'DEMO_ONLY');
    if (cmd.type === 'workspace.create') {
      if (this.registry.workspaces.some(w => w.id === e.requestId)) return { state: this.state(), createdId: e.requestId, message: 'This workspace operation already completed.' };
      const workspace: Workspace = { id: e.requestId, name: cmd.data.name, demo: cmd.data.demo, currency: cmd.data.currency };
      await this.persist(); this.store.close();
      this.store = new WorkspaceStore(dbPath(workspace.id), workspace);
      if (cmd.data.demo) this.store.db.transaction(() => seedDemo(this.store))();
      this.registry = { activeId: workspace.id, workspaces: [...this.registry.workspaces, workspace] };
      await this.persist();
      return { state: this.state(), createdId: workspace.id, message: 'Workspace created.' };
    }
    if (cmd.type === 'workspace.switch') {
      if (!this.registry.workspaces.some(w => w.id === cmd.data.id)) throw new AppError('Workspace not found.', 404, 'NOT_FOUND');
      if (cmd.data.id !== this.registry.activeId) { await this.persist(); this.open(cmd.data.id); this.registry = { ...this.registry, activeId: cmd.data.id }; await this.persist(); }
      return { state: this.state() };
    }
    const result = this.store.execute(cmd, e.requestId);
    const w = this.store.setting<Workspace>('workspace');
    this.registry.workspaces = this.registry.workspaces.map(x => x.id === w.id ? w : x);
    await this.persist();
    return { state: this.state(), ...result };
  }
}

// Each tab runs its own copy of the store. After another tab saves, reload from IndexedDB so a stale
// tab gets the same revision conflict the local server would give, instead of overwriting newer work.
const tabs = new BroadcastChannel(DB_NAME);
const manager = new DemoManager();
tabs.onmessage = () => { serial(() => manager.load()); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** Same error mapping as server/index.ts, so the UI shows identical messages. */
function failure(err: unknown) {
  if (err instanceof ZodError) return json({ error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'VALIDATION' }, 400);
  if (err instanceof AppError) return json({ error: err.message, code: err.code }, err.status);
  if (err instanceof RangeError || err instanceof TypeError) return json({ error: err.message, code: 'VALIDATION' }, 400);
  if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) return json({ error: 'This operation conflicts with an existing record. Refresh and try again.', code: 'CONFLICT' }, 409);
  console.error(err);
  return json({ error: 'The operation could not be completed. Your workspace was preserved.', code: 'SERVER_ERROR' }, 500);
}
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> { const result = queue.then(fn, fn); queue = result.catch(() => undefined); return result; }

async function handle(url: URL, init?: RequestInit): Promise<Response> {
  try {
    const path = url.pathname;
    if (path === '/api/session') return json({ token: 'browser-demo' });
    if (path === '/api/state') return json(manager.state());
    if (path === '/api/command' && init?.method === 'POST') return json(await serial(() => manager.execute(envelopeSchema.parse(JSON.parse(String(init.body))) as CommandEnvelope)));
    if (path === '/api/backup') throw new AppError('Full backups are part of the local app. In this browser demo your data stays in this browser only.', 422, 'DEMO_ONLY');
    if (path === '/api/export') return new Response(JSON.stringify({ format: 'billable-analysis', version: 1, exportedAt: new Date().toISOString(), state: manager.state() }, null, 2), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="billable-analysis.json"' } });
    const attachment = /^\/api\/attachments\/([^/]+)$/.exec(path);
    if (attachment) { const a = manager.store.attachmentBytes(decodeURIComponent(attachment[1])); return new Response(new Blob([a.bytes as unknown as Uint8Array<ArrayBuffer>], { type: a.mime }), { headers: { 'Content-Type': a.mime } }); }
    return json({ error: 'API route not found.', code: 'NOT_FOUND' }, 404);
  } catch (err) { return failure(err); }
}

const isApi = (href: string) => { const url = new URL(href, location.href); return url.origin === location.origin && url.pathname.startsWith('/api/') ? url : null; };

/** <img> and <a> load /api/* URLs without fetch(), so they are rewritten to blob: URLs from the in-page store. */
function serveElements() {
  const images = new WeakMap<HTMLImageElement, string>();
  const fix = async (img: HTMLImageElement) => {
    const src = img.getAttribute('src') ?? '', url = isApi(src);
    if (!url || images.get(img) === src) return;
    images.set(img, src);
    const response = await handle(url);
    if (response.ok && img.getAttribute('src') === src) { const blob = URL.createObjectURL(await response.blob()); images.set(img, blob); img.src = blob; }
  };
  const scan = (root: ParentNode) => root.querySelectorAll<HTMLImageElement>('img[src^="/api/"]').forEach(fix);
  new MutationObserver(records => records.forEach(r => {
    if (r.type === 'attributes' && r.target instanceof HTMLImageElement) fix(r.target);
    r.addedNodes.forEach(n => { if (n instanceof HTMLImageElement) fix(n); else if (n instanceof Element) scan(n); });
  })).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  document.addEventListener('click', async event => {
    const link = (event.target as Element | null)?.closest?.('a[href^="/api/"]') as HTMLAnchorElement | null;
    if (!link) return;
    event.preventDefault();
    const tab = link.target === '_blank' && !link.hasAttribute('download') ? window.open('', '_blank') : null;
    const response = await handle(new URL(link.href));
    if (!response.ok) { tab?.close(); alert((await response.json()).error); return; }
    const href = URL.createObjectURL(await response.blob());
    if (tab) tab.location.href = href;
    else { const a = Object.assign(document.createElement('a'), { href, download: link.getAttribute('download') || /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] || 'download' }); document.body.append(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }, true);
}

export async function resetDemo() {
  await new Promise(done => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = request.onerror = request.onblocked = done; });
  location.reload();
}

export async function bootDemo() {
  useSqlJs(await initSqlJs({ locateFile: () => wasmUrl }));
  await manager.load();
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = isApi(href);
    return url ? handle(url, init) : nativeFetch(input, init);
  };
  serveElements();
}

import type { AppState, ApiError, Command, CommandEnvelope, CommandResult, Upload } from '../shared/types';

let token = '';
/** status 0 means no response arrived: the change may or may not have been committed. */
export class RequestError extends Error { constructor(message: string, public code: string, public status: number) { super(message); } }
const unreachable = 'Billable did not respond. Check that the local server is still running.';
async function unpack<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let error: ApiError = { error: `Request failed (${response.status})`, code: 'NETWORK' };
    try { error = await response.json(); } catch { /* Preserve status when server is unavailable. */ }
    throw new RequestError(error.error, error.code, response.status);
  }
  return response.json();
}
async function get(url: string) { try { return await fetch(url, { cache: 'no-store' }); } catch { throw new RequestError(unreachable, 'NETWORK', 0); } }
async function session() { token = (await unpack<{ token: string }>(await get('/api/session'))).token; }
export async function getState(): Promise<AppState> {
  if (!token) await session();
  return unpack<AppState>(await get('/api/state'));
}
export async function sendCommand(workspaceId: string, command: Command, requestId: string = crypto.randomUUID()): Promise<CommandResult> {
  const envelope: CommandEnvelope = { requestId, workspaceId, command };
  const attempt = () => fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Billable-Token': token }, body: JSON.stringify(envelope) });
  // A connection can disappear after a successful commit. The same request ID makes this retry safe.
  const send = async () => { try { return await attempt(); } catch { try { return await attempt(); } catch { throw new RequestError(`${unreachable} Your change may not be saved yet; saving again will not apply it twice.`, 'NETWORK', 0); } } };
  let response = await send();
  if (response.status === 403 && (await response.clone().json().catch(() => null))?.code === 'SESSION_REQUIRED') {
    // The server restarted and issued a new local token. The rejected request never ran, so resend it once.
    await session(); response = await send();
  }
  return unpack<CommandResult>(response);
}
export async function fileUpload(file: File, limit = 5 * 1024 * 1024): Promise<Upload> {
  if (file.size > limit) throw new Error(`Choose a file smaller than ${Math.round(limit / 1024 / 1024)} MB.`);
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
  return { name: file.name, mime: file.type || 'application/octet-stream', base64 };
}
/** Fetches a download first so a failed backup is reported instead of saved as a broken file. */
export async function download(url: string, fallbackName: string): Promise<{ name: string; size: number }> {
  const response = await get(url);
  if (!response.ok) await unpack(response);
  const blob = await response.blob();
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
  const href = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
  return { name, size: blob.size };
}

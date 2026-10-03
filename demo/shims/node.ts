// Browser demo only: the few node:crypto / node:fs / node:path functions the server store imports.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const randomUUID = () => crypto.randomUUID();
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error(`Unsupported hash in demo: ${algorithm}`);
  const parts: Uint8Array[] = [];
  const hash = {
    update(data: string | Uint8Array) { parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data); return hash; },
    digest(encoding: 'hex') {
      if (encoding !== 'hex') throw new Error('Only hex digests are supported in the demo.');
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0; for (const p of parts) { all.set(p, offset); offset += p.length; }
      return bytesToHex(sha256(all));
    },
  };
  return hash;
}
export function mkdirSync() { /* No folders in the browser: databases live in IndexedDB. */ }
export const dirname = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || '/';
export const join = (...parts: string[]) => parts.join('/');

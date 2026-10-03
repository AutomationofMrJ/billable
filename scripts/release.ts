import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folders = ['src', 'shared', 'server', 'tests', 'scripts', 'public', 'dist', 'notices', 'third-party-licenses'];
const topLevel = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html',
  'README.md', 'BACKUP.md', 'API-CONTRACT.md', 'NAMING.md',
  'RELEASE-NOTES.md', 'THIRD-PARTY-NOTICES.md',
  'LICENSE', 'start.cmd', 'start.bat', 'start.ps1', 'Start-Billable.cmd', '.gitignore', '.nvmrc', '.npmrc',
];
const allowedExtensions = new Set(['.ts','.tsx','.js','.jsx','.css','.html','.json','.md','.txt','.svg','.png','.jpg','.jpeg','.ico','.woff','.woff2','.ttf','.map','.cmd','.bat','.ps1']);
const required = ['package.json', 'package-lock.json', 'README.md', 'BACKUP.md', 'LICENSE', 'server/index.ts', 'shared/types.ts', 'src/main.tsx'];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const files = new Map<string, Buffer>();
async function add(path: string): Promise<void> {
  const information = await lstat(path);
  if (information.isSymbolicLink()) throw new Error(`Release does not allow symbolic links: ${relative(root,path)}`);
  const actual = await realpath(path);
  if (!actual.startsWith(root + sep)) throw new Error('Release path resolves outside this project.');
  const name = relative(root, path).split(sep).join('/');
  if (/\.(?:sqlite|db|zip|env|log|pem|key|pfx)(?:[-.]|$)/i.test(name) || /(?:^|\/)\.(?:env|git|codex|agents)(?:\/|$)/i.test(name)) throw new Error(`Private/runtime file in release allowlist: ${name}`);
  if (information.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) await add(join(path, entry));
  } else {
    if (!allowedExtensions.has(extname(name).toLowerCase()) && !topLevel.includes(name) && !(name.startsWith('third-party-licenses/') && extname(name) === '')) throw new Error(`Unsupported release file type: ${name}`);
    files.set(name, await readFile(path));
  }
}
for (const name of [...topLevel, ...folders]) {
  try { await lstat(join(root,name)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  await add(join(root,name));
}
for (const name of required) if (!files.has(name)) throw new Error(`Required release file is missing: ${name}`);
const metadata = JSON.parse(files.get('package.json')!.toString('utf8'));
if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(metadata.version)) throw new Error('Package version is invalid.');
const archive = new AdmZip();
for (const [name, bytes] of files) archive.addFile(`billable-local/${name}`, bytes);
archive.addFile('billable-local/RELEASE-MANIFEST.json', Buffer.from(JSON.stringify({
  name: 'billable-local', version: metadata.version, createdAt: new Date().toISOString(),
  kind: files.has('dist/index.html') ? 'source-with-browser-build' : 'source',
  files: Object.fromEntries([...files].map(([name,bytes]) => [name,{size:bytes.length,sha256:sha256(bytes)}])),
}, null, 2) + '\n'));
const buffer = archive.toBuffer();
const verify = new AdmZip(buffer);
if (verify.getEntries().length !== files.size + 1) throw new Error('Release archive has an unexpected number of files.');
for (const [name, bytes] of files) if (!verify.readFile(`billable-local/${name}`)?.equals(bytes)) throw new Error(`Release verification failed: ${name}`);
const target = join(root,'releases'); await mkdir(target,{recursive:true});
const name = `billable-local-${metadata.version}.zip`;
await writeFile(join(target,name),buffer);
await writeFile(join(target,`${name}.sha256`),`${sha256(buffer)}  ${name}\n`);
process.stdout.write(`Created releases/${name} (${files.size} files, ${(buffer.length/1024/1024).toFixed(2)} MiB).\nVerified every packaged file against its source. Runtime data and node_modules are excluded.\n`);

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAst } from 'rolldown/parseAst';

export const src = join(import.meta.dirname, '..', 'src');
type Node = { type: string; [key: string]: unknown };

/** Every literal passed to t() or msg() in the interface source, in source order. */
export function collectKeys(): { keys: string[]; dynamic: string[] } {
  const keys = new Set<string>(); const dynamic: string[] = [];
  for (const file of readdirSync(src).filter(name => /\.tsx?$/.test(name)).sort()) {
    const code = readFileSync(join(src, file), 'utf8');
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Node;
      if (n.type === 'CallExpression') {
        const callee = n.callee as Node & { name?: string };
        const [first] = n.arguments as Node[];
        if (callee.type === 'Identifier' && (callee.name === 't' || callee.name === 'msg') && first) {
          if (first.type === 'Literal' && typeof first.value === 'string') keys.add(first.value);
          else dynamic.push(`${file}: ${code.slice(first.start as number, first.end as number)}`);
        }
      }
      // Only descend into child nodes; other properties can refer back up the tree.
      for (const [key, value] of Object.entries(n)) {
        if (key === 'parent') continue;
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof (value as Node).type === 'string') walk(value);
      }
    };
    walk(parseAst(code, { lang: file.endsWith('x') ? 'tsx' : 'ts' }));
  }
  return { keys: [...keys], dynamic };
}

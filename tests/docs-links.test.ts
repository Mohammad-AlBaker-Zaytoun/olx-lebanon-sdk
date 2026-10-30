/** Every relative link in the docs points at a file that exists, and every #anchor at a heading. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name.startsWith('.') ? [] : markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, duplicates numbered. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  const withoutCode = markdown.replace(/^```[\s\S]*?^```/gm, '');
  for (const [, text] of withoutCode.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = text!
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

const files = [
  join(ROOT, 'README.md'),
  join(ROOT, 'CHANGELOG.md'),
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'SECURITY.md'),
  join(ROOT, 'CODE_OF_CONDUCT.md'),
  ...markdownFiles(join(ROOT, 'docs')),
  ...markdownFiles(join(ROOT, 'examples')),
  join(ROOT, 'extension/README.md'),
];

describe('documentation links', () => {
  it.each(files.map((f) => [relative(ROOT, f), f]))('%s', (_name, file) => {
    const text = readFileSync(file, 'utf8')
      .replace(/^```[\s\S]*?^```/gm, '')
      .replace(/`[^`\n]*`/g, '');
    const broken: string[] = [];
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target!)) continue;
      const [rawPath, anchor] = target!.split('#');
      const path = rawPath ? resolve(dirname(file), decodeURIComponent(rawPath)) : file;
      if (!existsSync(path)) {
        broken.push(`${target} (no such file)`);
        continue;
      }
      if (anchor && path.endsWith('.md') && !anchors(readFileSync(path, 'utf8')).has(anchor)) {
        broken.push(`${target} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });
});

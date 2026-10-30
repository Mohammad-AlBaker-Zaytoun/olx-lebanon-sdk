/**
 * Builds the OLX Connect browser extension (Manifest V3, Chrome and Edge) into a folder you can
 * load unpacked or zip for the Chrome Web Store.
 *
 *   npm run build:extension                         # origins from extension/allowed-origins.txt
 *   npm run build:extension -- --origins https://www.example.com,https://example.com
 *   npm run build:extension -- --store              # without the `key` field, for the Web Store
 *
 * Options: --origins <list>  --key <public key file>  --out <folder>  --store
 * The origins can also come from OLX_CONNECT_ALLOWED_ORIGINS.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');

export interface BuildExtensionOptions {
  /** Exact origins allowed to ask for a token. */
  origins: string[];
  /** The extension's public key (base64 DER, or a PEM file's text). Fixes the extension id. */
  publicKey?: string;
  /** Leave the `key` field out of the manifest (the Chrome Web Store sets the id itself). */
  store?: boolean;
  outDir: string;
}

/** Checks and normalizes the allowed origins: exact https origins (http only for localhost). */
export function parseOrigins(list: string | string[]): string[] {
  const items = (Array.isArray(list) ? list : list.split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new Error('Give at least one allowed origin (e.g. https://www.example.com)');
  const out = new Set<string>();
  for (const item of items) {
    if (item.includes('*')) throw new Error(`Wildcards are not allowed: ${item}`);
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`Not a valid origin: ${item}`);
    }
    if (url.origin !== item.replace(/\/$/, '')) {
      throw new Error(`Give the origin only (scheme, host and port, no path): ${item} → ${url.origin}`);
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error(`Origins must use https (http only for localhost): ${item}`);
    }
    out.add(url.origin);
  }
  return [...out];
}

/** The base64 DER (SubjectPublicKeyInfo) form of a public key given as base64 or PEM. */
export function normalizePublicKey(text: string): string {
  const body = text
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(body) || body.length < 200) throw new Error('The public key is not base64 DER or PEM');
  return body;
}

/** The extension id Chrome derives from a public key. */
export function extensionIdFromKey(publicKeyBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// --- Icons: a small PNG encoder, so the build needs no image files or libraries. ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** The OLX Connect icon: two linked rings on a green rounded square. */
export function iconPng(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling for smooth edges
  const green = [0x23, 0x82, 0x6f];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          // Rounded square, corner radius 0.22.
          const r = 0.22;
          const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
          const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
          if (Math.hypot(dx, dy) > r) continue;
          bg++;
          // Two rings, centres 0.37 and 0.63, radius 0.19, thickness 0.075.
          const ring = (cx: number) => Math.abs(Math.hypot(u - cx, v - 0.5) - 0.19) < 0.0375;
          if (ring(0.37) || ring(0.63)) fg++;
        }
      }
      const total = SS * SS;
      const a = bg / total;
      const f = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(green[0]! * (1 - f) + 255 * f);
      rgba[i + 1] = Math.round(green[1]! * (1 - f) + 255 * f);
      rgba[i + 2] = Math.round(green[2]! * (1 - f) + 255 * f);
      rgba[i + 3] = Math.round(255 * a);
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function buildExtension(o: BuildExtensionOptions): Promise<{ id: string | null; outDir: string }> {
  const origins = parseOrigins(o.origins);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const key = o.store || !o.publicKey ? undefined : normalizePublicKey(o.publicKey);
  const outDir = resolve(o.outDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'icons'), { recursive: true });

  await build({
    entryPoints: { background: join(EXT, 'src/background.ts'), confirm: join(EXT, 'src/confirm.ts') },
    outdir: outDir,
    bundle: true,
    format: 'esm',
    target: 'chrome116',
    platform: 'browser',
    // Readable output: reviewers (and the Chrome Web Store) can read what the extension does.
    minify: false,
    legalComments: 'none',
    define: { __OLX_CONNECT_ALLOWED_ORIGINS__: JSON.stringify(origins) },
    logLevel: 'silent',
  });
  copyFileSync(join(EXT, 'src/confirm.html'), join(outDir, 'confirm.html'));
  copyFileSync(join(EXT, 'src/confirm.css'), join(outDir, 'confirm.css'));
  const icons: Record<string, string> = {};
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(join(outDir, `icons/icon-${size}.png`), iconPng(size));
    icons[String(size)] = `icons/icon-${size}.png`;
  }

  const sites = origins.map((s) => new URL(s).host).join(', ');
  const manifest = {
    manifest_version: 3,
    name: 'OLX Connect',
    version: pkg.version,
    description:
      `Lets ${sites} ask for your OLX Lebanon sign-in, only after you allow it. Unofficial, by Zaytoun Solutions.`.slice(0, 132),
    homepage_url: 'https://github.com/Mohammad-AlBaker-Zaytoun/olx-lebanon-sdk/tree/main/extension',
    minimum_chrome_version: '116',
    icons,
    permissions: ['cookies'],
    host_permissions: ['https://*.olx.com.lb/*'],
    background: { service_worker: 'background.js', type: 'module' },
    externally_connectable: { matches: origins.map((s) => `${s}/*`) },
    ...(key ? { key } : {}),
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { id: key ? extensionIdFromKey(key) : null, outDir };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
}

async function main(args: string[]): Promise<void> {
  const originsArg = flag(args, 'origins') ?? process.env.OLX_CONNECT_ALLOWED_ORIGINS;
  const origins = originsArg ?? readFileSync(join(EXT, 'allowed-origins.txt'), 'utf8').replace(/#.*$/gm, '');
  const keyFile = flag(args, 'key') ?? join(EXT, 'key.pub');
  const store = args.includes('--store');
  const { id, outDir } = await buildExtension({
    origins: parseOrigins(origins),
    publicKey: store ? undefined : readFileSync(keyFile, 'utf8'),
    store,
    outDir: flag(args, 'out') ?? join(EXT, store ? 'dist-store' : 'dist'),
  });
  console.log(`OLX Connect built in ${outDir}`);
  console.log(`  allowed origins: ${parseOrigins(origins).join(', ')}`);
  console.log(id ? `  extension id: ${id}` : '  extension id: set by the Chrome Web Store (no key in this build)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}

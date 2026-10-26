import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { basename, extname } from 'node:path';
import { ImageUploadError, OlxSdkError } from '../errors.js';
import type { OlxHttpClient } from '../http/HttpClient.js';
import type { OlxAdapter } from './adapter.js';
import { imageSize } from './imageSize.js';
import type { AccountInfo, ImageSource, UploadedImage } from './types.js';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: can map to 169.254.169.254 on IPv6-only networks
  ['64:ff9b:1::', 48], // local-use NAT64
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true; // not an IP at all: refuse rather than guess
}

const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface ImageUploaderOptions {
  http: OlxHttpClient;
  adapter: OlxAdapter;
  /**
   * If set, URL images may only come from these hostnames (or their subdomains), and those
   * hosts are trusted as-is (http and private addresses allowed — e.g. a store on your LAN).
   * If unset, any host is allowed but only over https and only if it resolves to a public address.
   */
  allowedHosts?: string[];
  maxBytes?: number;
  /** Per request (each redirect hop). */
  timeoutMs?: number;
  /** Overall budget for downloading all images of one listing, so one job can't hold the queue. */
  totalTimeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  /** DNS resolution, injectable for tests. */
  resolveHost?: (host: string) => Promise<string[]>;
}

interface LoadedImage {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

/** Origin + path only: signed-URL tokens in the query must not end up in logs or job errors. */
const safeUrl = (u: URL): string => u.origin + u.pathname;

export class ImageUploader {
  constructor(private readonly o: ImageUploaderOptions) {}

  /**
   * Fetches and uploads images one at a time, in order (only one image is in memory at a
   * time), with one overall download budget for the listing. Returns the uploaded photos.
   */
  async uploadAll(images: ImageSource[], account?: AccountInfo): Promise<UploadedImage[]> {
    const deadline = Date.now() + (this.o.totalTimeoutMs ?? 120_000);
    const out: UploadedImage[] = [];
    for (const [i, img] of images.entries()) out.push(await this.send(await this.load(img, i + 1, deadline), i + 1, account));
    return out;
  }

  async upload(img: ImageSource, position = 1, account?: AccountInfo): Promise<UploadedImage> {
    const deadline = Date.now() + (this.o.totalTimeoutMs ?? 120_000);
    return this.send(await this.load(img, position, deadline), position, account);
  }

  private async send(img: LoadedImage, n: number, account?: AccountInfo): Promise<UploadedImage> {
    const flow = this.o.adapter.signedUpload;
    if (flow) {
      // Read the size first: an unreadable image fails before anything is sent to OLX.
      const size = imageSize(img.data);
      if (!size) throw new ImageUploadError(`Image ${n} is not a readable JPEG, PNG, WebP or GIF`);
      const name = flow.newImageName(account);
      // Part of a single ad write: the caller already holds the write slot.
      const raw = await this.o.http.call('signImageUpload', { query: flow.signQuery(name), rateLimit: false });
      const uploadUrl = flow.parseSignedUrl(raw);
      await this.o.http.putToSignedUrl(uploadUrl, img.data, size.type, (url) => flow.isAllowedUploadUrl(url));
      return flow.toUploadedImage(name, { width: size.width, height: size.height, contentType: size.type, uploadUrl });
    }
    const form = new FormData();
    form.append(this.o.adapter.imageFieldName ?? 'file', new Blob([img.data as BlobPart], { type: img.contentType }), img.filename);
    const raw = await this.o.http.call('uploadImage', { form, rateLimit: false });
    return { id: this.o.adapter.parseImageUpload(raw), contentType: img.contentType };
  }

  private get maxBytes(): number {
    return this.o.maxBytes ?? 10 * 1024 * 1024;
  }

  private async load(img: ImageSource, n: number, deadline: number): Promise<LoadedImage> {
    let loaded: LoadedImage;
    if ('data' in img) {
      loaded = {
        data: img.data,
        filename: img.filename,
        contentType: img.contentType ?? MIME[extname(img.filename).toLowerCase()] ?? 'application/octet-stream',
      };
    } else if ('path' in img) {
      const data = await readFile(img.path).catch((err: NodeJS.ErrnoException) => {
        throw new ImageUploadError(`Image ${n} (${basename(img.path)}): ${err.code === 'ENOENT' ? 'file not found' : `cannot read the file (${err.code ?? err.message})`}`);
      });
      loaded = {
        data,
        filename: basename(img.path),
        contentType: MIME[extname(img.path).toLowerCase()] ?? 'application/octet-stream',
      };
    } else {
      loaded = await this.download(img.url, n, deadline);
    }

    if (loaded.data.byteLength > this.maxBytes) {
      throw new ImageUploadError(`Image ${n} is larger than ${this.maxBytes} bytes`);
    }
    if (!loaded.contentType.startsWith('image/')) {
      throw new ImageUploadError(`Image ${n} is not an image (${loaded.contentType})`);
    }
    return loaded;
  }

  private async download(raw: string, n: number, deadline: number): Promise<LoadedImage> {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const maxRedirects = this.o.maxRedirects ?? 3;
    let url = new URL(raw);

    for (let hop = 0; ; hop++) {
      await this.assertAllowed(url, n);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ImageUploadError(`Image ${n}: image downloads took too long for this listing`);
      // One signal covers headers AND body, so a slowly dripping body is cut off too.
      const signal = AbortSignal.timeout(Math.min(this.o.timeoutMs ?? 20_000, remaining));
      let res: Response;
      try {
        res = await fetchImpl(url, { redirect: 'manual', signal });
      } catch (err) {
        // Network errors from fetch embed the full URL (query, credentials); never pass them on.
        const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : 'could not connect';
        throw new ImageUploadError(`Image ${n} (${safeUrl(url)}): download ${reason}`);
      }

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (!location || hop >= maxRedirects) throw new ImageUploadError(`Image ${n}: too many or invalid redirects`);
        url = new URL(location, url); // every hop is re-checked at the top of the loop
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new ImageUploadError(`Image ${n} (${safeUrl(url)}): download failed with HTTP ${res.status}`);
      }

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxBytes) {
        await res.body?.cancel();
        throw new ImageUploadError(`Image ${n} is larger than ${this.maxBytes} bytes`);
      }
      let data: Uint8Array;
      try {
        data = await readCapped(res, this.maxBytes, n);
      } catch (err) {
        if (err instanceof OlxSdkError) throw err;
        throw new ImageUploadError(`Image ${n} (${safeUrl(url)}): download was interrupted`);
      }
      const name = basename(url.pathname) || 'image.jpg';
      return {
        data,
        filename: name,
        contentType:
          res.headers.get('content-type')?.split(';')[0]?.trim() || MIME[extname(name).toLowerCase()] || 'image/jpeg',
      };
    }
  }

  private async assertAllowed(url: URL, n: number): Promise<void> {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ImageUploadError(`Image ${n}: unsupported URL scheme ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new ImageUploadError(`Image ${n}: URLs with embedded credentials are not accepted`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const allowed = this.o.allowedHosts;
    if (allowed) {
      if (!allowed.some((h) => host === h || host.endsWith('.' + h))) {
        throw new ImageUploadError(`Image ${n}: host "${host}" is not in OLX_IMAGE_HOSTS`);
      }
      return; // explicitly trusted
    }
    if (url.protocol !== 'https:') {
      throw new ImageUploadError(`Image ${n}: only https image URLs are accepted (or list the host in OLX_IMAGE_HOSTS)`);
    }
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : await (this.o.resolveHost ?? defaultResolve)(host);
    } catch {
      throw new ImageUploadError(`Image ${n}: could not resolve host "${host}"`);
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new ImageUploadError(
        `Image ${n}: host "${host}" resolves to a private or internal address (list it in OLX_IMAGE_HOSTS to allow it)`,
      );
    }
  }
}

async function readCapped(res: Response, max: number, n: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ImageUploadError(`Image ${n} is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

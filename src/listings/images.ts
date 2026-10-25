import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { OlxSdkError } from '../errors.js';
import type { OlxHttpClient } from '../http/HttpClient.js';
import type { OlxAdapter } from './adapter.js';
import type { ImageSource } from './types.js';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface ImageUploaderOptions {
  http: OlxHttpClient;
  adapter: OlxAdapter;
  /** If set, URL images are only fetched from these hostnames (or their subdomains). */
  allowedHosts?: string[];
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

interface LoadedImage {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

export class ImageUploader {
  constructor(private readonly o: ImageUploaderOptions) {}

  /** Uploads images one at a time, in order, and returns OLX's image ids. */
  async uploadAll(images: ImageSource[]): Promise<string[]> {
    const ids: string[] = [];
    for (const img of images) ids.push(await this.upload(img));
    return ids;
  }

  async upload(img: ImageSource): Promise<string> {
    const { data, filename, contentType } = await this.load(img);
    const form = new FormData();
    form.append(this.o.adapter.imageFieldName ?? 'file', new Blob([data as BlobPart], { type: contentType }), filename);
    const raw = await this.o.http.call('uploadImage', { form, rateLimit: false });
    return this.o.adapter.parseImageUpload(raw);
  }

  private async load(img: ImageSource): Promise<LoadedImage> {
    const maxBytes = this.o.maxBytes ?? 10 * 1024 * 1024;
    let loaded: LoadedImage;

    if ('data' in img) {
      loaded = {
        data: img.data,
        filename: img.filename,
        contentType: img.contentType ?? MIME[extname(img.filename).toLowerCase()] ?? 'application/octet-stream',
      };
    } else if ('path' in img) {
      loaded = {
        data: await readFile(img.path),
        filename: basename(img.path),
        contentType: MIME[extname(img.path).toLowerCase()] ?? 'application/octet-stream',
      };
    } else {
      const url = new URL(img.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new OlxSdkError(`Unsupported image URL scheme: ${url.protocol}`);
      }
      const allowed = this.o.allowedHosts;
      if (allowed && !allowed.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
        throw new OlxSdkError(`Image host "${url.hostname}" is not in OLX_IMAGE_HOSTS`);
      }
      const res = await (this.o.fetchImpl ?? fetch)(url);
      if (!res.ok) throw new OlxSdkError(`Could not download image ${url} (HTTP ${res.status})`);
      const name = basename(url.pathname) || 'image.jpg';
      loaded = {
        data: new Uint8Array(await res.arrayBuffer()),
        filename: name,
        contentType: res.headers.get('content-type')?.split(';')[0] ?? MIME[extname(name).toLowerCase()] ?? 'image/jpeg',
      };
    }

    if (loaded.data.byteLength > maxBytes) {
      throw new OlxSdkError(`Image ${loaded.filename} is ${loaded.data.byteLength} bytes; the limit is ${maxBytes}`);
    }
    if (!loaded.contentType.startsWith('image/')) {
      throw new OlxSdkError(`${loaded.filename} does not look like an image (${loaded.contentType})`);
    }
    return loaded;
  }
}

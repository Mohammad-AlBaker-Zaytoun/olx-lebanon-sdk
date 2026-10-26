import { ImageUploadError, UncertainWriteError } from '../errors.js';
import type { OlxHttpClient } from '../http/HttpClient.js';
import type { CatalogMapper } from '../mapping/CatalogMapper.js';
import type { OlxAdapter } from './adapter.js';
import type { ImageUploader } from './images.js';
import type { ListingInput, OlxAd } from './types.js';

export interface ListingsPort {
  create(input: ListingInput): Promise<OlxAd>;
  update(adId: string, input: ListingInput): Promise<OlxAd>;
  delete(adId: string): Promise<void>;
}

export interface ListingsApiDeps {
  http: OlxHttpClient;
  mapper: CatalogMapper;
  adapter: OlxAdapter;
  images: ImageUploader;
}

/** Create, edit, delete and read ads on your own OLX account. */
export class ListingsApi implements ListingsPort {
  constructor(private readonly d: ListingsApiDeps) {}

  async create(input: ListingInput): Promise<OlxAd> {
    // Map first so a bad product fails before anything is sent.
    const mapped = this.d.mapper.resolve(input);
    // Take the write slot before uploading, so images aren't uploaded long before the ad that uses them.
    await this.d.http.acquireWriteSlot();
    const imageIds = await this.uploadImages(input);
    const raw = await this.d.http.call('createAd', {
      json: this.d.adapter.buildAdPayload(mapped, imageIds),
      rateLimit: false,
    });
    try {
      return this.d.adapter.parseAd(raw);
    } catch (err) {
      // OLX accepted the request, but we can't tell which ad it made: never treat this as "not created".
      throw new UncertainWriteError('createAd', `OLX accepted the ad but the response could not be read: ${(err as Error).message}`, {
        cause: err,
        body: raw,
      });
    }
  }

  async update(adId: string, input: ListingInput): Promise<OlxAd> {
    const mapped = this.d.mapper.resolve(input);
    await this.d.http.acquireWriteSlot();
    const imageIds = await this.uploadImages(input);
    const raw = await this.d.http.call('updateAd', {
      params: { id: adId },
      json: this.d.adapter.buildAdPayload(mapped, imageIds),
      rateLimit: false,
    });
    // Some edit endpoints answer 204/empty; the ad id doesn't change on edit.
    if (raw === undefined || raw === '') return { id: adId, status: 'unknown', raw };
    try {
      return this.d.adapter.parseAd(raw);
    } catch {
      return { id: adId, status: 'unknown', raw };
    }
  }

  /**
   * An image upload with an unknown outcome is not an uncertain *ad*: no ad request has been
   * sent yet, so at worst an orphan image exists on OLX. Report it as a plain failure so
   * the product isn't parked for manual reconciliation.
   */
  private async uploadImages(input: ListingInput): Promise<string[]> {
    try {
      return await this.d.images.uploadAll(input.images ?? []);
    } catch (err) {
      if (err instanceof UncertainWriteError) {
        throw new ImageUploadError(`Image upload failed before the ad was sent: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }

  async delete(adId: string): Promise<void> {
    await this.d.http.call('deleteAd', { params: { id: adId } });
  }

  async get(adId: string): Promise<OlxAd> {
    return this.d.adapter.parseAd(await this.d.http.call('getAd', { params: { id: adId } }));
  }

  async listMine(query?: Record<string, string | number | boolean | undefined>): Promise<OlxAd[]> {
    return this.d.adapter.parseAdList(await this.d.http.call('listMyAds', { query }));
  }
}

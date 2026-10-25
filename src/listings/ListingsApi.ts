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
    // Map first so a bad product fails before any image is uploaded.
    const mapped = this.d.mapper.resolve(input);
    const imageIds = await this.d.images.uploadAll(input.images ?? []);
    const raw = await this.d.http.call('createAd', { json: this.d.adapter.buildAdPayload(mapped, imageIds) });
    return this.d.adapter.parseAd(raw);
  }

  async update(adId: string, input: ListingInput): Promise<OlxAd> {
    const mapped = this.d.mapper.resolve(input);
    const imageIds = await this.d.images.uploadAll(input.images ?? []);
    const raw = await this.d.http.call('updateAd', {
      params: { id: adId },
      json: this.d.adapter.buildAdPayload(mapped, imageIds),
    });
    // Some edit endpoints answer 204/empty; the ad id doesn't change on edit.
    if (raw === undefined || raw === '') return { id: adId, status: 'unknown', raw };
    return this.d.adapter.parseAd(raw);
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

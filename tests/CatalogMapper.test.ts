import { describe, expect, it } from 'vitest';
import { MappingError } from '../src/errors.js';
import { CatalogMapper, parseCatalog } from '../src/mapping/CatalogMapper.js';
import { catalog } from './helpers.js';

const mapper = new CatalogMapper(catalog);
const base = {
  title: 'iPhone 15 128GB',
  description: 'Sealed box',
  price: 799,
  categoryKey: 'phones',
  locationKey: 'beirut',
  attributes: { brand: 'Apple' },
};

describe('CatalogMapper', () => {
  it('maps keys to OLX ids, applies defaults and renames attributes', () => {
    expect(mapper.resolve(base)).toEqual({
      categoryId: '123',
      locationId: 'loc-1',
      title: 'iPhone 15 128GB',
      description: 'Sealed box',
      price: 799,
      currency: 'USD',
      attributes: { make: 'Apple', condition: 'new' },
    });
  });

  it('lets product attributes override defaults', () => {
    expect(mapper.resolve({ ...base, attributes: { brand: 'Apple', condition: 'used' } }).attributes).toEqual({
      make: 'Apple',
      condition: 'used',
    });
  });

  it('collects every problem into one MappingError', () => {
    try {
      mapper.resolve({
        ...base,
        title: 'A title that is far too long for the limit',
        categoryKey: 'phones',
        attributes: {},
        images: [{ url: 'https://a.test/1.jpg' }, { url: 'https://a.test/2.jpg' }, { url: 'https://a.test/3.jpg' }],
      });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MappingError);
      const issues = (err as MappingError).issues;
      expect(issues.some((i) => i.includes('Title'))).toBe(true);
      expect(issues.some((i) => i.includes('images'))).toBe(true);
      expect(issues.some((i) => i.includes('requires: brand'))).toBe(true);
    }
  });

  it('rejects unknown category and location keys', () => {
    expect(() => mapper.resolve({ ...base, categoryKey: 'cars', locationKey: 'tripoli' })).toThrow(
      /Unknown categoryKey "cars".*Unknown locationKey "tripoli"/,
    );
  });
});

describe('CatalogMapper: locations OLX would reject', () => {
  const ids = new CatalogMapper(catalog);
  const ad = { title: 'Laptop', description: 'New', price: 899, categoryId: '175' };

  it('refuses a district or the whole country before anything is sent, and suggests areas', () => {
    const district = (() => {
      try {
        ids.resolve({ ...ad, locationId: '2' });
      } catch (e) {
        return e as MappingError;
      }
    })();
    expect(district).toBeInstanceOf(MappingError);
    expect(district?.issues.join()).toMatch(/district "Beirut".*e\.g\. \d+ \(/);
    expect(() => ids.resolve({ ...ad, locationId: 1 })).toThrow(MappingError);
  });

  it('accepts areas, and ids missing from the snapshot (OLX may have added them since)', () => {
    expect(ids.resolve({ ...ad, locationId: '47' }).locationId).toBe('47');
    expect(ids.resolve({ ...ad, locationId: '99999999' }).locationId).toBe('99999999');
  });
});

describe('CatalogMapper: listingDefaults', () => {
  const ad = { title: 'Laptop', description: 'New, sealed.', price: 899, categoryId: '175' };
  const withDefaults = (listingDefaults: Record<string, unknown>) =>
    new CatalogMapper(parseCatalog({ locations: { shop: { olxLocationId: '99' } }, listingDefaults }));

  it("uses the default location when a listing gives none, and the listing's own when it does", () => {
    expect(withDefaults({ locationId: '99' }).resolve(ad).locationId).toBe('99');
    expect(withDefaults({ locationKey: 'shop' }).resolve(ad).locationId).toBe('99');
    expect(withDefaults({ locationId: '99' }).resolve({ ...ad, locationId: '47' }).locationId).toBe('47');
  });

  it('refuses a district as the default, like any location', () => {
    expect(() => withDefaults({ locationId: '2' }).resolve(ad)).toThrow(/district "Beirut"/);
  });

  it('adds the footer once, after a blank line, and counts it in the length limit', () => {
    const m = withDefaults({ locationId: '99', descriptionFooter: 'Delivery all over Lebanon' });
    expect(m.resolve(ad).description).toBe('New, sealed.\n\nDelivery all over Lebanon');
    expect(m.resolve({ ...ad, description: 'New.\n\nDelivery all over Lebanon' }).description).toBe(
      'New.\n\nDelivery all over Lebanon',
    );
    expect(() => m.resolve({ ...ad, description: 'x'.repeat(4090) })).toThrow(/with the footer; OLX allows 4096/);
  });

  it('rejects both a default locationId and locationKey', () => {
    expect(() => parseCatalog({ listingDefaults: { locationId: '99', locationKey: 'shop' } })).toThrow(/not both/);
  });
});

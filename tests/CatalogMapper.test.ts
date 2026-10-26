import { describe, expect, it } from 'vitest';
import { MappingError } from '../src/errors.js';
import { CatalogMapper } from '../src/mapping/CatalogMapper.js';
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

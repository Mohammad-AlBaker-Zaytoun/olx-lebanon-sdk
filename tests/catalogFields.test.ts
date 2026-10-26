import { describe, expect, it } from 'vitest';
import { catalogEntry, categoryLabel, describeFields, listCategories, postableFields, type OlxField } from '../src/tools/catalogFields.js';

const tree = [
  {
    id: 3,
    name: 'Mobile Phones & Accessories',
    externalID: '147',
    level: 0,
    children: [
      { id: 70, name: 'Mobile Phones', externalID: '9', level: 1, children: [] },
      { id: 71, name: 'Mobile Accessories', externalID: '148', level: 1, children: [] },
    ],
  },
];

const fields: OlxField[] = [
  { attribute: 'price', name: 'Price', valueType: 'float', isMandatory: false, roles: ['filterable'], maxValue: 50000 },
  { attribute: 'price_type', name: 'Price Type', valueType: 'enum', isMandatory: true, choices: [{ value: 'price', label: 'Price' }] },
  { attribute: 'make', name: 'Brand', valueType: 'enum', isMandatory: true, choices: { a: [{ value: '1', label: 'Apple' }], b: [{ value: '2', label: 'Samsung' }] } },
  { attribute: 'new_used', name: 'Condition', valueType: 'enum', isMandatory: false, choices: [{ value: 'new', label: 'New' }] },
  { attribute: 'hot', name: 'Hot', valueType: 'enum', isMandatory: true, roles: ['exclude_from_post_an_ad'] },
];

describe('catalog helpers', () => {
  it('lists categories with ids, filtered by text', () => {
    expect(listCategories(tree)).toHaveLength(3);
    expect(listCategories(tree, 'accessories')).toEqual([
      '   147  Mobile Phones & Accessories  (has subcategories)',
      '   148  Mobile Phones & Accessories > Mobile Accessories',
    ]);
    expect(categoryLabel(tree, '9')).toBe('Mobile Phones & Accessories > Mobile Phones');
  });

  it('keeps only fields the posting form shows', () => {
    expect(postableFields(fields).map((f) => f.attribute)).toEqual(['price', 'price_type', 'make', 'new_used']);
  });

  it('lists every choice by default', () => {
    const many: OlxField = { attribute: 'make', name: 'Brand', valueType: 'enum', isMandatory: true, choices: Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: `B${i}` })) };
    expect(describeFields([many])).toContain('"59" = B59');
    expect(describeFields([many])).not.toContain('more');
  });

  it('describes fields with their choices, including grouped choices', () => {
    const text = describeFields(fields);
    expect(text).toContain('REQUIRED  make  [enum]  "Brand"');
    expect(text).toContain('"2" = Samsung');
    expect(text).toContain('(filled from the product price)');
    expect(text).not.toContain('hot');
  });

  it('starts a catalog entry with the required, non-price fields', () => {
    expect(catalogEntry('9', 'Phones', fields)).toEqual({
      label: 'Phones',
      olxCategoryId: '9',
      requiredAttributes: ['make'],
      attributeMap: {},
      // Every choice field, label → OLX value (grouped choices flattened); price fields left out.
      valueMap: { make: { Apple: '1', Samsung: '2' }, new_used: { New: 'new' } },
      defaults: {},
      priceLimits: { max: 50000 },
    });
  });
});

describe('shipped example config', () => {
  it('catalog.example.json and endpoints.example.json parse, with every OLX Lebanon endpoint mapped', async () => {
    const { readFileSync } = await import('node:fs');
    const { parseCatalog } = await import('../src/mapping/CatalogMapper.js');
    const { parseEndpoints } = await import('../src/endpoints.js');
    const { olxLebanonAdapter } = await import('../src/listings/olxLebanon.js');
    const catalog = parseCatalog(JSON.parse(readFileSync('config/catalog.example.json', 'utf8')));
    expect(catalog.locations.beirut?.olxLocationId).toBe('2');
    const endpoints = parseEndpoints(JSON.parse(readFileSync('config/endpoints.example.json', 'utf8')));
    for (const name of olxLebanonAdapter.requiredEndpoints!) expect(endpoints[name], name).not.toBeNull();
  });
});

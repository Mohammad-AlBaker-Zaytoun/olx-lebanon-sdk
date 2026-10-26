import { describe, expect, it } from 'vitest';
import { summarizeHar } from '../src/tools/har.js';
import { buildShapeReport, describeAuthorization, shapeOf, type HarFull } from '../src/tools/harShapes.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `eyJ${b64({ alg: 'RS256' }).slice(3)}.${b64({
  iss: 'https://auth.example.com/realms/olx-lb',
  sub: 'user-uuid-should-not-leak',
  email: 'mohammad@example.com',
  azp: 'frontend',
  iat: 1_000,
  exp: 1_300,
})}.c2lnbmF0dXJl`;

const PERSONAL = [
  'Test Seller',
  'mohammad@example.com',
  '+96170123456',
  '70123456',
  'iPhone 15 Pro Max 256GB like new',
  'SuperSecretPassw0rd',
  'user-uuid-should-not-leak',
  'c2lnbmF0dXJl',
  'AKIAEXAMPLE',
  '117145974',
];

const har: HarFull = {
  log: {
    entries: [
      {
        request: {
          method: 'POST',
          url: 'https://api-prod.olx-dubizzle.com/api/v1/post-ad',
          headers: [
            { name: 'Authorization', value: `Bearer ${jwt}` },
            { name: 'content-type', value: 'application/json' },
            { name: 'cookie', value: 'sid=abc123secretvalue; lang=en' },
          ],
          postData: {
            mimeType: 'application/json',
            text: JSON.stringify({
              title: 'iPhone 15 Pro Max 256GB like new',
              description: 'catcatca',
              image_name: '0b9f3c1e-5d2a-4e8b-9c7d-1a2b3c4d5e6f_1792981885661.png',
              ref: 'img_18030034',
              price: 900,
              currency: 'USD',
              category: { externalID: '1453', slug: 'mobile-phones' },
              location: '0-1-37-12',
              contactInfo: { name: 'Test Seller', phone: '+96170123456' },
              phoneNumber: 70123456,
              userName: 'Test Seller',
              password: 'SuperSecretPassw0rd',
              photos: [{ id: 117145974, url: 'https://images.example.com/thumbnails/117145974-800x600.webp' }],
              extraFields: { condition: 'used', storage: '256' },
            }),
          },
        },
        response: {
          status: 200,
          content: {
            mimeType: 'application/json',
            text: JSON.stringify({ id: 117145974, state: 'pending', externalID: '117145974' }),
          },
        },
      },
      {
        request: {
          method: 'PUT',
          url: 'https://olx-lb-prod.s3.eu-central-1.amazonaws.com/uploads/a1b2c3d4e5f6a7b8c9d0.jpg?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeef&X-Amz-Expires=300',
          headers: [{ name: 'content-type', value: 'image/jpeg' }],
          postData: { mimeType: 'image/jpeg', text: 'ÿØbinary' },
        },
        response: { status: 200, content: { mimeType: 'text/plain', text: '' } },
      },
      {
        request: { method: 'GET', url: 'https://api-prod.olx-dubizzle.com/api/v1/categoryFields?categoryExternalIDs=1453' },
        response: {
          status: 200,
          content: {
            mimeType: 'application/json',
            text: JSON.stringify({ fields: [{ name: 'Condition', attribute: 'condition', choices: ['new', 'used'] }] }),
          },
        },
      },
      {
        request: { method: 'GET', url: 'https://tracker.example/collect' },
        response: { status: 200, content: { mimeType: 'application/json', text: '{"leak":"Test Seller"}' } },
      },
    ],
  },
};

describe('buildShapeReport', () => {
  const { text, publicData } = buildShapeReport(har, {
    hosts: ['olx-dubizzle.com', 'olx-lb-prod.s3.eu-central-1.amazonaws.com'],
    isPublic: (u) => /categoryFields/.test(u.pathname),
  });

  it('never prints personal values, tokens or ids', () => {
    for (const secret of PERSONAL) expect(text).not.toContain(secret);
    expect(text).not.toContain('abc123secretvalue');
    expect(text).not.toContain('deadbeef');
  });

  it('keeps structure, enum-like values and safe headers', () => {
    expect(text).toContain('POST api-prod.olx-dubizzle.com/api/v1/post-ad');
    expect(text).toContain('"description": "<text 8 chars>"');
    expect(text).toContain('"image_name": "<id {uuid}_{d13}.png>"');
    expect(text).toContain('"ref": "<id img_{d8}>"');
    expect(text).toContain('"currency": "USD"');
    expect(text).toContain('"slug": "<text 13 chars>"'); // slugs can echo the title
    expect(text).toContain('"externalID": "1453"');
    expect(text).toContain('"location": "0-1-37-12"');
    expect(text).toContain('"condition": "used"');
    expect(text).toContain('"price": 900');
    expect(text).toContain('"title": "<text 32 chars>"');
    expect(text).toMatch(/"contactInfo": \{\s*"name": "<masked string>",\s*"phone": "<masked string>"\s*\}/);
    expect(text).toContain('content-type: application/json');
    expect(text).toContain('cookie names sent: sid, lang');
  });

  it('describes the upload without its signature', () => {
    expect(text).toContain('PUT olx-lb-prod.s3.eu-central-1.amazonaws.com/uploads/{id}');
    expect(text).not.toContain('1792981885661');
    expect(text).not.toContain('18030034');
    expect(text).not.toContain('catcatca');
    expect(text).toContain('X-Amz-Expires=300');
    expect(text).toContain('request body: image/jpeg');
  });

  it('summarises the token without identity claims', () => {
    expect(text).toContain('"lifetimeSeconds":300');
    expect(text).toContain('auth.example.com/realms/olx-lb');
    expect(text).toContain('"azp":"frontend"');
  });

  it('keeps public catalog responses verbatim and ignores other hosts', () => {
    const [entry] = Object.values(publicData)[0]!;
    expect(entry).toMatchObject({ query: { categoryExternalIDs: '1453' }, response: { fields: [{ name: 'Condition' }] } });
    expect(text).toContain('[public data]');
    expect(text).not.toContain('tracker.example');
  });
});

describe('path ids', () => {
  it('shows how many digits a path id has, not the id', () => {
    const { text } = buildShapeReport(
      {
        log: {
          entries: [
            {
              request: { method: 'POST', url: 'https://api-prod.olx-dubizzle.com/api/v1/ads/117145974/delete' },
              response: { status: 204 },
            },
          ],
        },
      },
      { hosts: ['olx-dubizzle.com'] },
    );
    expect(text).toContain('POST api-prod.olx-dubizzle.com/api/v1/ads/{id:9 digits}/delete');
    expect(text).not.toContain('117145974');
  });
});

describe('shapeOf', () => {
  it('masks values under secret-looking keys and shortens arrays', () => {
    expect(shapeOf({ accessToken: 'x', items: [1, 2, 3, 4] })).toEqual({
      accessToken: '<masked string>',
      items: [1, 2, '…+2 more'],
    });
    expect(shapeOf({ contact_person: { name: 'Mo', phone: [70123456, 3123456] } })).toEqual({
      contact_person: { name: '<masked string>', phone: ['<masked number>', '…+1 more'] },
    });
  });
  it('collapses id-like keys', () => {
    expect(shapeOf({ '117145974': { ok: true } })).toEqual({ '{id}': { ok: true } });
  });
  it('treats an opaque authorization value as opaque', () => {
    expect(describeAuthorization('Bearer abcdef')).toEqual({ scheme: 'Bearer', kind: 'opaque' });
  });
});

describe('summarizeHar and uploads', () => {
  it('keeps a PUT to an image path (an upload) but still drops static GETs', () => {
    const calls = summarizeHar(har);
    expect(calls.some((c) => c.method === 'PUT' && c.pattern.includes('amazonaws.com/uploads/{id}'))).toBe(true);
  });
});

/**
 * The REST service's OpenAPI 3.1 document, served at GET /v1/openapi.json and shipped as
 * openapi.json. Generate a client for any language from it (openapi-generator, NSwag, …).
 * Tests check that it matches the routes and is a valid OpenAPI document.
 */
import { createRequire } from 'node:module';

const version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorResponse') } },
});
const json = (schema: unknown, description: string) => ({ description, content: { 'application/json': { schema } } });

const productId = {
  name: 'productId',
  in: 'path',
  required: true,
  description: "Your product's id: 1-128 letters, digits and . _ : -",
  schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
};

const common = {
  '401': errorResponse('Missing or wrong X-Api-Key (`unauthorized`)'),
  '500': errorResponse('Internal error (`internal_error`); details are in the service log'),
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'olx-lebanon-sdk REST service',
    version,
    description:
      'Post, edit and delete your own OLX Lebanon ads from any language. Writes are queued and paced: they answer ' +
      '202 with a job id; poll GET /v1/jobs/{jobId} or configure a webhook for the outcome. Each product keeps ' +
      'exactly one ad. Errors always have the shape `{ "error": { "code", "message", "details"?, "requestId" } }`; ' +
      'branch on `code`.',
    license: { name: 'MIT' },
  },
  servers: [{ url: 'http://127.0.0.1:8787', description: 'Default local service (`olx-lb serve`)' }],
  security: [{ ApiKey: [] }],
  tags: [
    { name: 'Listings', description: "Your products' ads" },
    { name: 'Jobs', description: 'Outcome of queued writes' },
    { name: 'Service', description: 'Health, status and this document' },
  ],
  paths: {
    '/v1/health': {
      get: {
        tags: ['Service'],
        operationId: 'getHealth',
        summary: 'Liveness check',
        security: [],
        responses: {
          '200': json({ type: 'object', properties: { ok: { const: true } }, required: ['ok'] }, 'The service is up'),
        },
      },
    },
    '/v1/openapi.json': {
      get: {
        tags: ['Service'],
        operationId: 'getOpenApi',
        summary: 'This OpenAPI document',
        security: [],
        responses: { '200': json({ type: 'object' }, 'The OpenAPI document') },
      },
    },
    '/v1/status': {
      get: {
        tags: ['Service'],
        operationId: 'getStatus',
        summary: 'Session, queue, write pacing, and products that need attention',
        responses: { '200': json(ref('Status'), 'Service status'), ...common },
      },
    },
    '/v1/listings': {
      get: {
        tags: ['Listings'],
        operationId: 'listListings',
        summary: 'Every stored product ↔ ad link',
        responses: {
          '200': json(
            { type: 'object', properties: { listings: { type: 'array', items: ref('SyncRecord') } }, required: ['listings'] },
            'All links',
          ),
          ...common,
        },
      },
    },
    '/v1/products/{productId}/listing': {
      parameters: [productId],
      get: {
        tags: ['Listings'],
        operationId: 'getListing',
        summary: "A product's link to its ad",
        responses: {
          '200': json(ref('SyncRecord'), 'The link'),
          '404': errorResponse('No link for this product (`not_found`)'),
          ...common,
        },
      },
      put: {
        tags: ['Listings'],
        operationId: 'upsertListing',
        summary: "Create the product's ad, or edit it in place",
        description:
          'Queues a sync: the first time it posts an ad, later it edits the same ad, and unchanged content is skipped ' +
          '(use `force=true` to push anyway). Photos are only re-uploaded when they change.',
        parameters: [
          {
            name: 'force',
            in: 'query',
            required: false,
            description: 'Push even if the content is unchanged',
            schema: { type: 'string', enum: ['true', '1'] },
          },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: ref('Listing') } } },
        responses: {
          '202': json(ref('Accepted'), 'Queued'),
          '400': errorResponse('Invalid product id or listing (`invalid_product_id`, `invalid_listing` with `details.issues`)'),
          '413': errorResponse('Body over 1 MB (`payload_too_large`)'),
          '429': errorResponse('Too many products waiting (`queue_full`); retry after `Retry-After` seconds'),
          '503': errorResponse('Shutting down (`shutting_down`)'),
          ...common,
        },
      },
      delete: {
        tags: ['Listings'],
        operationId: 'deleteListing',
        summary: "Delete the product's ad",
        responses: {
          '202': json(ref('Accepted'), 'Queued'),
          '400': errorResponse('Invalid product id (`invalid_product_id`)'),
          '429': errorResponse('Too many products waiting (`queue_full`)'),
          '503': errorResponse('Shutting down (`shutting_down`)'),
          ...common,
        },
      },
    },
    '/v1/products/{productId}/listing/resolve': {
      parameters: [productId],
      post: {
        tags: ['Listings'],
        operationId: 'resolveListing',
        summary: 'Resolve a parked product (needs_reconcile or gone)',
        description:
          '`link`: the ad exists on OLX, manage it from now on (also adopts an ad posted by hand). `forget`: no ad exists, ' +
          'the next sync creates one. Both refuse unsafe cases with 409 unless `replace` / `force` is set.',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Resolution') } } },
        responses: {
          '200': json(
            {
              oneOf: [
                ref('SyncRecord'),
                { type: 'object', properties: { forgotten: { type: 'boolean' } }, required: ['forgotten'] },
              ],
            },
            'Resolved',
          ),
          '400': errorResponse('Invalid product id or body (`invalid_product_id`, `invalid_resolution`)'),
          '409': errorResponse('Would orphan or share an ad (`link_conflict`, `healthy_link`; `details.adId`)'),
          ...common,
        },
      },
    },
    '/v1/jobs/{jobId}': {
      parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['Jobs'],
        operationId: 'getJob',
        summary: 'A queued write and its outcome',
        responses: {
          '200': json(ref('Job'), 'The job'),
          '404': errorResponse('Unknown or expired job (`not_found`)'),
          ...common,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key', description: 'SERVER_API_KEY from the service settings' },
    },
    schemas: {
      Listing: {
        type: 'object',
        description:
          'An ad. Give the category as `categoryId` (an OLX id) or `categoryKey` (your catalog), and the location as ' +
          "`locationId` (an OLX area id) or `locationKey`, or leave the location out to use the catalog's " +
          '`listingDefaults`. A `listingDefaults.descriptionFooter` is added to the description when the job runs.',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 70 },
          description: { type: 'string', minLength: 1, maxLength: 4096 },
          price: {
            oneOf: [
              { type: 'number', minimum: 0 },
              { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*$' },
            ],
            description: 'A number, or a decimal string such as "799.00"',
          },
          currency: { type: 'string', enum: ['USD', 'LBP'], default: 'USD' },
          categoryId: {
            oneOf: [
              { type: 'string', pattern: '^\\d+$' },
              { type: 'integer', minimum: 1 },
            ],
            examples: ['175'],
          },
          categoryKey: { type: 'string', minLength: 1 },
          locationId: {
            oneOf: [
              { type: 'string', pattern: '^\\d+$' },
              { type: 'integer', minimum: 1 },
            ],
            examples: ['47'],
          },
          locationKey: { type: 'string', minLength: 1 },
          attributes: {
            description: "The category's fields (OLX names and choice values with categoryId). An empty array means none.",
            oneOf: [
              { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
              { type: 'array', maxItems: 0 },
            ],
            examples: [{ make: '3', type: '1', new_used: '1' }],
          },
          images: {
            type: 'array',
            maxItems: 20,
            items: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] },
          },
        },
        required: ['title', 'description', 'price'],
        examples: [
          {
            title: 'Dell Latitude 5440',
            description: '16 GB RAM, 512 GB SSD, 1 year warranty',
            price: 899,
            categoryId: '175',
            locationId: '47',
            attributes: { make: '3', type: '1', new_used: '1' },
            images: [{ url: 'https://shop.example.com/dell-5440.jpg' }],
          },
        ],
      },
      Resolution: {
        oneOf: [
          {
            type: 'object',
            properties: { action: { const: 'link' }, adId: { type: 'string' }, replace: { type: 'boolean' } },
            required: ['action', 'adId'],
          },
          { type: 'object', properties: { action: { const: 'forget' }, force: { type: 'boolean' } }, required: ['action'] },
        ],
      },
      Accepted: {
        type: 'object',
        properties: { jobId: { type: 'string' }, status: { type: 'string', enum: ['queued'] } },
        required: ['jobId', 'status'],
      },
      AdStatus: {
        type: 'string',
        enum: ['active', 'pending_review', 'limited', 'rejected', 'expired', 'deleted', 'unknown'],
        description: '`limited`: the account used its free ads in that category; the ad needs a paid OLX package to be shown.',
      },
      SyncRecord: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          adId: { type: 'string', description: "OLX's ad id (empty while a create is in flight or parked)" },
          adUrl: { type: 'string' },
          status: ref('AdStatus'),
          syncState: {
            type: 'string',
            enum: ['creating', 'needs_reconcile', 'gone'],
            description: 'Absent when the link is healthy',
          },
          contentHash: { type: 'string' },
          imagesHash: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          lastSyncedAt: { type: 'string', format: 'date-time' },
          lastError: { type: 'string' },
        },
        required: ['productId', 'adId', 'status', 'contentHash', 'createdAt', 'lastSyncedAt'],
      },
      ErrorCode: {
        type: 'string',
        description: 'Stable codes: branch on these, not on messages.',
        enum: [
          'unauthorized',
          'not_found',
          'invalid_product_id',
          'invalid_listing',
          'invalid_resolution',
          'link_conflict',
          'healthy_link',
          'queue_full',
          'shutting_down',
          'payload_too_large',
          'bad_request',
          'internal_error',
          'auth_failed',
          'olx_rejected',
          'outcome_unknown',
          'image_upload_failed',
          'reconcile_required',
          'endpoint_not_configured',
          'sdk_error',
          'cancelled',
        ],
      },
      ErrorInfo: {
        type: 'object',
        properties: {
          code: ref('ErrorCode'),
          message: { type: 'string' },
          status: { type: 'integer', description: "OLX's HTTP status, when OLX answered" },
          details: {
            type: 'object',
            description:
              'Depends on the code: `issues` (invalid_listing), `olxMessage` / `olxErrors` (olx_rejected, e.g. ' +
              '{"location_id": ["Please select a more specific location."]}), `reason` (reconcile_required), `adId`.',
            additionalProperties: true,
          },
        },
        required: ['code', 'message'],
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            allOf: [ref('ErrorInfo'), { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] }],
          },
        },
        required: ['error'],
      },
      Job: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['upsert', 'remove'] },
          productId: { type: 'string' },
          force: { type: 'boolean' },
          status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
          createdAt: { type: 'string', format: 'date-time' },
          startedAt: { type: 'string', format: 'date-time' },
          finishedAt: { type: 'string', format: 'date-time' },
          result: {
            description: 'When succeeded: { action: created | updated | unchanged, record } or { action: deleted, adId }',
            type: 'object',
            additionalProperties: true,
          },
          error: ref('ErrorInfo'),
        },
        required: ['id', 'type', 'productId', 'status', 'createdAt'],
      },
      Status: {
        type: 'object',
        properties: {
          session: {
            type: 'object',
            properties: { loggedIn: { type: 'boolean' }, savedAt: { type: 'string' }, cookieCount: { type: 'integer' } },
          },
          missingEndpoints: { type: 'array', items: { type: 'string' } },
          queue: { type: 'object', additionalProperties: true },
          writesLastHour: { type: 'integer' },
          needsAttention: {
            type: 'array',
            items: {
              type: 'object',
              properties: { productId: { type: 'string' }, syncState: { type: 'string' }, lastError: { type: 'string' } },
            },
          },
        },
        additionalProperties: true,
      },
    },
  },
} as const;

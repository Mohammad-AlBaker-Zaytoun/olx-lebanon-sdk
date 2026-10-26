/** Writes openapi.json (the REST service's OpenAPI document) at the repo root: npm run openapi */
import { writeFileSync } from 'node:fs';
import { openApiDocument } from '../src/server/openapi.js';

writeFileSync('openapi.json', JSON.stringify(openApiDocument, null, 2) + '\n');
console.log(`Wrote openapi.json (version ${openApiDocument.info.version})`);

/**
 * Turns a HAR recording into a report you can share when mapping the wire format: for each
 * API call, the query parameter names, request header names, and the request and response
 * bodies with personal values masked. Structure, key names and enum-like values are kept;
 * free text, names, phone numbers, emails, tokens and long ids are replaced with a
 * description such as `<text 42 chars>`.
 *
 * Responses from public catalog endpoints (categories, category fields, location search)
 * can also be saved verbatim, since that data is the same for every visitor.
 */
import { isSensitiveSegment } from './har.js';

export interface HarEntryFull {
  request: {
    method: string;
    url: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    headers?: Array<{ name: string; value: string }>;
    content?: { mimeType?: string; text?: string; encoding?: string; size?: number };
  };
}

export interface HarFull {
  log: { entries: HarEntryFull[] };
}

/** Keys whose values are always masked, whatever they look like. */
const SECRET_KEY =
  /pass|token|secret|auth|cookie|session|otp|^code$|phone|mobile|whatsapp|email|e_mail|^name$|first_?name|last_?name|full_?name|user_?name|contact|address|^sub$|^sid$|ip_?addr|device_?id|^jti$|nonce|signature|^sig$|credential|^key$/i;

/** Keys holding free text: always described, even when the value looks like an enum. */
const TEXT_KEY = /^(title|description|message|slug|body|text|comment|summary|details?|name)(_l\d+|_ar|_en)?$/i;

/** Request headers whose values are safe and useful to see. */
const SAFE_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'origin',
  'x-requested-with',
  'x-platform',
  'x-client',
  'x-app-version',
  'x-language',
  'x-lang',
  'x-site',
]);

/** Enum-like strings: lowercase identifiers/slugs, or short ALL-CAPS codes such as `USD`. */
const ENUM_LIKE = /^([a-z][a-z0-9]*([_.-][a-z0-9]+)*|[A-Z][A-Z0-9_]{0,11})$/;

export interface ShapeOptions {
  /** Keep values as they are (public catalog data). Arrays are still shortened. */
  keepValues?: boolean;
  /** Array items shown before `…+N more`. */
  maxItems?: number;
  maxDepth?: number;
}

function describeString(s: string): string {
  if (s === '') return '';
  if (/^\d+$/.test(s)) return s.length <= 4 ? s : `<digits ${s.length}>`;
  if (/^-?\d+\.\d+$/.test(s)) return '<decimal string>';
  if (/^[0-9a-f-]{36}$/i.test(s)) return '<uuid>';
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(s)) return '<jwt>';
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `<url ${u.host}${u.pathname.split('/').map((seg) => (isSensitiveSegment(seg) ? '{id}' : seg)).join('/')}>`;
    } catch {
      return '<url>';
    }
  }
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/.test(s)) return '<datetime>';
  if (s.includes('@')) return '<email-like>';
  // Hierarchical ids such as location `0-1-37-12`: short numeric segments.
  if (/^\d{1,4}([-_.]\d{1,4}){2,}$/.test(s)) return s;
  if (/^\+?\d[\d\s().-]{5,}$/.test(s)) return '<phone-like>';
  if (s.length <= 32 && ENUM_LIKE.test(s) && !/\d{5,}/.test(s) && !isSensitiveSegment(s)) return s;
  if (!/\s/.test(s)) return `<id ${idPattern(s)}>`;
  return `<text ${s.length} chars>`;
}

/**
 * The format of an identifier without its content, e.g. `{uuid}_{d13}.png` or `img_{d8}`.
 * Digits become `{dN}`, hex runs `{hN}`, other mixed runs `{xN}`; short lowercase words
 * and separators are kept.
 */
export function idPattern(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '\u0000')
    .split(/([-_./:=+]|\u0000)/)
    .map((part) => {
      if (part === '\u0000') return '{uuid}';
      if (part === '' || /^[-_./:=+]$/.test(part)) return part;
      if (/^\d+$/.test(part)) return `{d${part.length}}`;
      if (/^[a-z]{1,12}$/.test(part)) return part;
      if (/^[0-9a-f]+$/i.test(part)) return `{h${part.length}}`;
      return `{x${part.length}}`;
    })
    .join('');
}

/** Masks every value but keeps the structure and key names. */
function maskDeep(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '<masked>';
  if (Array.isArray(value)) return value.length ? [maskDeep(value[0], depth + 1), ...(value.length > 1 ? [`…+${value.length - 1} more`] : [])] : [];
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[isSensitiveSegment(k) ? '{id}' : k] = maskDeep(v, depth + 1);
    return out;
  }
  return `<masked ${typeof value}>`;
}

function describeNumber(n: number): number | string {
  if (Number.isInteger(n) && Math.abs(n) >= 1_000_000) return `<int ${String(Math.abs(n)).length} digits>`;
  return n;
}

export function shapeOf(value: unknown, opts: ShapeOptions = {}, depth = 0, key?: string): unknown {
  const maxItems = opts.maxItems ?? 2;
  const maxDepth = opts.maxDepth ?? 12;
  if (depth > maxDepth) return '<…>';
  if (!opts.keepValues && key !== undefined && SECRET_KEY.test(key)) {
    return maskDeep(value, depth);
  }
  if (!opts.keepValues && key !== undefined && TEXT_KEY.test(key) && typeof value === 'string') {
    return value === '' ? '' : `<text ${value.length} chars>`;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => shapeOf(v, opts, depth + 1, key));
    if (value.length > maxItems) items.push(`…+${value.length - maxItems} more`);
    return items;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys can be ids too (`{ "117145974": {...} }`).
      const shownKey = !opts.keepValues && isSensitiveSegment(k) ? '{id}' : k;
      if (shownKey in out) continue;
      out[shownKey] = shapeOf(v, opts, depth + 1, k);
    }
    return out;
  }
  if (opts.keepValues) return value;
  if (typeof value === 'string') return describeString(value);
  if (typeof value === 'number') return describeNumber(value);
  return value;
}

function decodeText(content?: { text?: string; encoding?: string }): string | undefined {
  if (!content?.text) return undefined;
  if (content.encoding === 'base64') {
    try {
      return Buffer.from(content.text, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  return content.text;
}

/** Parses JSON or NDJSON; returns undefined for anything else. */
export function parseJsonish(text: string | undefined, mime = ''): unknown {
  if (!text) return undefined;
  const t = text.trim();
  if (mime.includes('ndjson') || (/^\{/.test(t) && t.includes('\n{'))) {
    try {
      return t.split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

export interface TokenInfo {
  scheme: string;
  kind: 'jwt' | 'opaque';
  lifetimeSeconds?: number;
  issuer?: string;
  claims?: string[];
  details?: Record<string, unknown>;
}

/**
 * Describes an Authorization header without revealing it: the scheme and, for a JWT, the
 * issuer, lifetime and claim names. Identity claims are never printed.
 */
export function describeAuthorization(value: string): TokenInfo {
  const [scheme = '', token = ''] = value.split(/\s+/, 2);
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
      const details: Record<string, unknown> = {};
      for (const k of ['typ', 'azp', 'aud', 'scope']) {
        if (payload[k] !== undefined) details[k] = shapeOf(payload[k], {}, 0, 'x');
      }
      const iat = typeof payload.iat === 'number' ? payload.iat : undefined;
      const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
      let issuer: string | undefined;
      if (typeof payload.iss === 'string') {
        try {
          const u = new URL(payload.iss);
          issuer = u.host + u.pathname;
        } catch {
          issuer = '<not a url>';
        }
      }
      return {
        scheme,
        kind: 'jwt',
        issuer,
        lifetimeSeconds: iat !== undefined && exp !== undefined ? exp - iat : undefined,
        claims: Object.keys(payload).sort(),
        details,
      };
    } catch {
      /* not a JWT after all */
    }
  }
  return { scheme, kind: 'opaque' };
}

export interface ShapeReportOptions {
  /** Hosts (and their subdomains) whose calls are described. */
  hosts: string[];
  /** Calls whose responses are public catalog data, kept verbatim (shortened). */
  isPublic?: (url: URL) => boolean;
}

const STATIC = /\.(js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)$/i;
const within = (host: string, d: string) => host === d || host.endsWith('.' + d);

function pathPattern(u: URL, withDigits = false): string {
  return (
    u.host +
    u.pathname
      .split('/')
      .map((s) => (!isSensitiveSegment(s) ? s : withDigits && /^\d+$/.test(s) ? `{id:${s.length} digits}` : '{id}'))
      .join('/')
  );
}

/**
 * Builds the shareable report. Only the first two calls per method+path are shown in full.
 * Returns the report text plus the full public responses keyed by a file-safe name.
 */
export function buildShapeReport(har: HarFull, opts: ShapeReportOptions): { text: string; publicData: Record<string, unknown[]> } {
  const lines: string[] = [];
  const seen = new Map<string, number>();
  const publicData: Record<string, unknown[]> = {};
  const tokens = new Map<string, TokenInfo>();

  for (const { request, response } of har.log.entries) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (!opts.hosts.some((d) => within(host, d))) continue;
    const isGet = request.method === 'GET';
    const respMime = response.content?.mimeType ?? '';
    if (isGet && STATIC.test(url.pathname)) continue;
    if (isGet && !respMime.includes('json')) continue;

    const reqHeaders = request.headers ?? [];
    const auth = reqHeaders.find((h) => h.name.toLowerCase() === 'authorization');
    if (auth) tokens.set(host, describeAuthorization(auth.value));

    const pattern = `${request.method} ${pathPattern(url, true)}`;
    const n = (seen.get(pattern) ?? 0) + 1;
    seen.set(pattern, n);
    const isPublic = opts.isPublic?.(url) ?? false;
    const respText = decodeText(response.content);
    const respJson = parseJsonish(respText, respMime);

    if (isPublic && respJson !== undefined) {
      const name = pathPattern(url).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
      (publicData[name] ??= []).push({ query: Object.fromEntries(url.searchParams), request: parseJsonish(request.postData?.text, request.postData?.mimeType), response: respJson });
    }
    if (n > 2) continue;

    lines.push('='.repeat(100));
    lines.push(`${pattern}   → HTTP ${response.status}${n > 1 ? '   (2nd call)' : ''}${isPublic ? '   [public data]' : ''}`);
    const query = [...url.searchParams.entries()];
    if (query.length) {
      lines.push(
        'query: ' +
          query.map(([k, v]) => `${k}=${isPublic ? v.slice(0, 120) : String(shapeOf(v, {}, 0, k))}`).join('&'),
      );
    }
    const headerList = reqHeaders
      .filter((h) => !h.name.startsWith(':'))
      .map((h) => {
        const name = h.name.toLowerCase();
        return SAFE_HEADERS.has(name) ? `${name}: ${h.value.slice(0, 80)}` : name;
      });
    if (headerList.length) lines.push('request headers: ' + [...new Set(headerList)].join(' | '));
    const cookieHeader = reqHeaders.find((h) => h.name.toLowerCase() === 'cookie');
    if (cookieHeader) {
      lines.push('cookie names sent: ' + cookieHeader.value.split(';').map((c) => c.split('=')[0]!.trim()).filter(Boolean).join(', '));
    }

    const reqMime = request.postData?.mimeType ?? '';
    if (request.postData) {
      const reqJson = parseJsonish(request.postData.text, reqMime);
      if (reqJson !== undefined) {
        lines.push(`request body (${reqMime || 'unknown type'}):`);
        lines.push(JSON.stringify(shapeOf(reqJson, { keepValues: isPublic, maxItems: isPublic ? 3 : 2 }), null, 2));
      } else {
        lines.push(`request body: ${reqMime || 'unknown type'}, ${request.postData.text?.length ?? 0} chars (not JSON, not shown)`);
      }
    }

    const setCookies = (response.headers ?? []).filter((h) => h.name.toLowerCase() === 'set-cookie');
    if (setCookies.length) {
      lines.push('cookies set: ' + setCookies.flatMap((h) => h.value.split('\n')).map((c) => c.split('=')[0]!.trim()).join(', '));
    }
    const location = (response.headers ?? []).find((h) => h.name.toLowerCase() === 'location');
    if (location) lines.push('redirect to: ' + String(shapeOf(location.value)));

    if (respJson !== undefined) {
      lines.push(`response body (${respMime}):`);
      lines.push(JSON.stringify(shapeOf(respJson, { keepValues: isPublic, maxItems: isPublic ? 3 : 2 }), null, 2));
    } else if (respText) {
      lines.push(`response body: ${respMime || 'unknown type'}, ${respText.length} chars (not JSON, not shown)`);
    }
  }

  const head: string[] = [];
  if (tokens.size) {
    head.push('AUTHORIZATION HEADERS (values never shown)');
    for (const [host, info] of tokens) head.push(`  ${host}: ${JSON.stringify(info)}`);
    head.push('');
  }
  head.push('CALL COUNTS');
  for (const [pattern, count] of seen) head.push(`  x${String(count).padEnd(3)} ${pattern}`);
  head.push('');
  return { text: [...head, ...lines].join('\n') + '\n', publicData };
}

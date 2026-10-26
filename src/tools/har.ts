/** Minimal slice of the HAR 1.2 format that the summariser reads. */
export interface HarLike {
  log: {
    entries: Array<{
      request: { method: string; url: string; postData?: { mimeType?: string; text?: string } };
      response: { status: number; content?: { mimeType?: string } };
    }>;
  };
}

export interface HarCall {
  method: string;
  /** Origin + path, with numeric / long-hex segments collapsed to `{id}`. */
  pattern: string;
  statuses: number[];
  count: number;
  requestType?: string;
  responseType?: string;
}

const STATIC = /\.(js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)$/i;
const ID_SEGMENT = /^(\d{3,}|[0-9a-f]{16,}|[0-9a-f-]{36})$/i;

/**
 * Path segments that may carry identifiers or secrets: ids, tokens (JWT / base64url),
 * emails, phone numbers, and any long mixed letter+digit string. Collapsed to `{id}` so the
 * summary is safe to share.
 */
export function isSensitiveSegment(raw: string): boolean {
  let seg: string;
  try {
    seg = decodeURIComponent(raw);
  } catch {
    seg = raw;
  }
  if (!seg) return false;
  if (ID_SEGMENT.test(seg)) return true;
  // `117145974.json`, `abc…def.html`: judge the name without its extension too.
  const stem = seg.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  if (stem !== seg && isSensitiveSegment(stem)) return true;
  if (seg.includes('@')) return true; // email
  if (/^\+?\d[\d\s().-]{5,}$/.test(seg)) return true; // phone-like
  if (/^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]+)?$/.test(seg) && !/\.(json|html?|php|aspx?)$/i.test(seg)) {
    return true; // JWT-ish / dotted token
  }
  if (seg.length >= 16 && /[A-Za-z]/.test(seg) && /\d/.test(seg)) return true; // long mixed token or slug-with-id
  if (seg.length >= 32) return true;
  return false;
}

/**
 * Reduces a HAR recording to the API calls that matter for mapping endpoints:
 * anything that isn't GET, plus GETs that return JSON. Static assets are dropped.
 */
export function summarizeHar(har: HarLike, hostFilter?: (host: string) => boolean): HarCall[] {
  const calls = new Map<string, HarCall>();
  for (const { request, response } of har.log.entries) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }
    if (hostFilter && !hostFilter(url.hostname)) continue;
    // Static-looking paths are skipped for reads only: a PUT to `…/photo.jpg` is an upload.
    if (request.method === 'GET' && STATIC.test(url.pathname)) continue;
    const responseType = response.content?.mimeType;
    const isApi = request.method !== 'GET' || (responseType ?? '').includes('json');
    if (!isApi) continue;

    const pattern =
      url.origin +
      url.pathname
        .split('/')
        .map((seg) => (isSensitiveSegment(seg) ? '{id}' : seg))
        .join('/');
    const key = `${request.method} ${pattern}`;
    const existing = calls.get(key);
    if (existing) {
      existing.count++;
      if (!existing.statuses.includes(response.status)) existing.statuses.push(response.status);
    } else {
      calls.set(key, {
        method: request.method,
        pattern,
        statuses: [response.status],
        count: 1,
        requestType: request.postData?.mimeType,
        responseType,
      });
    }
  }
  // Writes first — those are the ones you need to map.
  return [...calls.values()].sort((a, b) => Number(a.method === 'GET') - Number(b.method === 'GET'));
}

export function formatHarSummary(calls: HarCall[]): string {
  if (calls.length === 0) return 'No API-looking calls found in the recording.';
  return calls
    .map(
      (c) =>
        `${c.method.padEnd(6)} ${c.statuses.join(',').padEnd(8)} x${String(c.count).padEnd(3)} ${c.pattern}` +
        (c.requestType ? `  [body: ${c.requestType}]` : ''),
    )
    .join('\n');
}

export interface HostActivity {
  host: string;
  /** Request count per HTTP method, e.g. `{ GET: 3, POST: 1 }`. */
  methods: Record<string, number>;
}

/**
 * Tallies requests per host and method, for hosts that were NOT recorded into the HAR.
 * Only hostnames and method counts are kept, never paths, headers or bodies, so the result
 * is safe to share. It tells you which host to add to OLX_EXTRA_HOSTS when a call is missing.
 */
export function tallyHosts(
  requests: Iterable<{ method: string; url: string }>,
  isRecorded: (host: string) => boolean,
): HostActivity[] {
  const byHost = new Map<string, Record<string, number>>();
  for (const { method, url } of requests) {
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      host = u.hostname.toLowerCase();
    } catch {
      continue;
    }
    if (isRecorded(host)) continue;
    const methods = byHost.get(host) ?? {};
    methods[method] = (methods[method] ?? 0) + 1;
    byHost.set(host, methods);
  }
  const writes = (m: Record<string, number>) =>
    Object.entries(m).reduce((n, [k, v]) => n + (k === 'GET' || k === 'HEAD' || k === 'OPTIONS' ? 0 : v), 0);
  return [...byHost.entries()]
    .map(([host, methods]) => ({ host, methods }))
    .sort((a, b) => writes(b.methods) - writes(a.methods) || a.host.localeCompare(b.host));
}

export function formatHostActivity(hosts: HostActivity[]): string {
  if (hosts.length === 0) return 'No other hosts were contacted.';
  return hosts
    .map(
      (h) =>
        `${h.host.padEnd(40)} ${Object.entries(h.methods)
          .map(([m, n]) => `${m} x${n}`)
          .join(', ')}`,
    )
    .join('\n');
}

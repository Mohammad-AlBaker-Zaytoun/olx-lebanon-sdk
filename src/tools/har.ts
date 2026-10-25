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
    if (STATIC.test(url.pathname)) continue;
    const responseType = response.content?.mimeType;
    const isApi = request.method !== 'GET' || (responseType ?? '').includes('json');
    if (!isApi) continue;

    const pattern =
      url.origin +
      url.pathname
        .split('/')
        .map((seg) => (ID_SEGMENT.test(seg) ? '{id}' : seg))
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

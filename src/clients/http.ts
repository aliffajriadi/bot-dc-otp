import { logger, maskSecrets, maskUrl } from '../logger.js';

export class HttpError extends Error {
  constructor(
    message: string,
    /** true = server menjawab dengan penolakan jelas; false = tidak pasti (timeout/jaringan) */
    public readonly definite: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** jumlah retry tambahan untuk kegagalan jaringan (hanya untuk request baca) */
  retries?: number;
  /** kembalikan body JSON walau HTTP status bukan 2xx (provider kadang membalas 500 dengan body valid) */
  acceptErrorJson?: boolean;
  label: string;
  orderId?: string;
}

export async function httpJson(url: string, opts: HttpOptions): Promise<unknown> {
  const attempts = (opts.retries ?? 0) + 1;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      const text = await res.text();
      logger.debug({ label: opts.label, url: maskUrl(url), status: res.status, orderId: opts.orderId }, 'http call');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      if (!res.ok && !(opts.acceptErrorJson && json !== undefined)) {
        logger.warn({ label: opts.label, status: res.status, body: maskSecrets(text.slice(0, 300)), orderId: opts.orderId }, 'respons non-2xx');
        const msg = (json as { message?: string; msg?: string } | undefined)?.message ?? (json as { msg?: string } | undefined)?.msg ?? `HTTP ${res.status}`;
        const snippet = json === undefined ? ` — ${maskSecrets(text.replace(/\s+/g, ' ').slice(0, 200))}` : '';
        throw new HttpError(maskSecrets(String(msg)) + snippet, res.status < 500, res.status);
      }
      if (json === undefined) throw new HttpError('Respons bukan JSON', false, res.status);
      return json;
    } catch (e) {
      if (e instanceof HttpError) {
        lastErr = e;
        if (e.definite) break; // jangan retry penolakan jelas
      } else {
        // fetch error: jangan teruskan pesan asli (bisa memuat URL + api_key)
        const reason = e instanceof Error ? e.name : 'error';
        lastErr = new HttpError(`Gagal menghubungi server (${reason})`, false);
      }
      logger.warn({ label: opts.label, url: maskUrl(url), attempt: i, orderId: opts.orderId, err: maskSecrets(String((lastErr as Error).message)) }, 'http gagal');
    }
  }
  throw lastErr;
}

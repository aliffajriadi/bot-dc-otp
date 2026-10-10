import pino from 'pino';

/** Ganti nilai api_key di URL/teks supaya aman untuk dilog. */
export function maskSecrets(text: string): string {
  return text.replace(/(api_key=)[^&\s"']*/gi, '$1***').replace(/(x-api-key"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***');
}

export function maskUrl(url: string | URL): string {
  return maskSecrets(String(url));
}

export const logger = pino({
  level: process.env.VITEST ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  redact: {
    paths: ['*.apiKey', '*.api_key', '*.token', 'headers["x-api-key"]', '*.headers["x-api-key"]'],
    censor: '***',
  },
});

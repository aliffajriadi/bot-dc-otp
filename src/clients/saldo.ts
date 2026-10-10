import { HttpError, httpJson } from './http.js';

export interface SaldoUser {
  discordId: string;
  balanceRupiah: number;
  isBlacklisted: boolean;
  role?: string;
}

export class SaldoError extends Error {
  constructor(message: string, public readonly definite: boolean) {
    super(message);
    this.name = 'SaldoError';
  }
}

export interface SaldoApi {
  /** null = user tidak ditemukan */
  checkUser(discordId: string): Promise<SaldoUser | null>;
  adjust(p: { discordId: string; action: 'deduct' | 'add'; amountRp: number; description: string; orderId?: string }): Promise<void>;
}

export function parseSaldoUser(body: unknown): SaldoUser | null {
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== 'object') return null;
  if (b.success === false || b.status === false) return null;
  const d = (b.data ?? b) as Record<string, any>;
  if (!d || typeof d !== 'object' || d.discordId === undefined) return null;
  const bal = Number(d.balanceRupiah ?? 0);
  return {
    discordId: String(d.discordId),
    balanceRupiah: Number.isFinite(bal) ? Math.floor(bal) : 0,
    isBlacklisted: d.isBlacklisted === true || d.isBlacklisted === 'true' || d.isBlacklisted === 1,
    role: d.role,
  };
}

export class SaldoClient implements SaldoApi {
  constructor(private baseUrl: string, private apiKey: string) {}

  private url(path: string) {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  async checkUser(discordId: string): Promise<SaldoUser | null> {
    try {
      const body = await httpJson(this.url(`/api/users/check?discordId=${encodeURIComponent(discordId)}`), {
        headers: { 'x-api-key': this.apiKey },
        label: 'saldo.check',
        retries: 1,
      });
      return parseSaldoUser(body);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw new SaldoError(e instanceof Error ? e.message : 'gagal cek saldo', e instanceof HttpError ? e.definite : false);
    }
  }

  async adjust(p: { discordId: string; action: 'deduct' | 'add'; amountRp: number; description: string; orderId?: string }): Promise<void> {
    if (!Number.isInteger(p.amountRp) || p.amountRp <= 0) throw new SaldoError('Nominal tidak valid', true);
    try {
      const body = (await httpJson(this.url('/api/users/balance'), {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: { discordId: p.discordId, action: p.action, amountWl: 0, amountRp: p.amountRp, description: p.description },
        label: `saldo.${p.action}`,
        orderId: p.orderId,
        // sengaja tanpa retry: tidak ada idempotency key di API saldo
      })) as Record<string, unknown>;
      if (body?.success === false || body?.status === false || body?.status === 'false') {
        throw new SaldoError(String(body.message ?? body.msg ?? 'Saldo API menolak'), true);
      }
    } catch (e) {
      if (e instanceof SaldoError) throw e;
      throw new SaldoError(e instanceof Error ? e.message : 'gagal ubah saldo', e instanceof HttpError ? e.definite : false);
    }
  }
}

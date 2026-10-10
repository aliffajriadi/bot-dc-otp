import { logger, maskSecrets } from '../logger.js';
import { toInt } from '../util/format.js';
import { HttpError, httpJson } from './http.js';

export const PROVIDER_ERRORS = [
  "You don't have Access!", 'BAD ACTION', 'NO BALANCE', 'INVALID OPERATOR', 'INVALID SERVICE ID', 'WRONG SERVICE ID',
  'WRONG OPERATOR ID', 'WRONG COUNTRY ID', 'INVALID ORDER ID', 'WRONG ORDER ID', 'WRONG STATUS', 'INVALID STATUS',
] as const;

export class ProviderError extends Error {
  constructor(message: string, public readonly definite: boolean) {
    super(message);
    this.name = 'ProviderError';
  }
  get noBalance() {
    return this.message.trim().toUpperCase() === 'NO BALANCE';
  }
}

export interface Country { id: string; name: string }
export interface Operator { id: string; name: string }
export interface Service { id: string; name: string; price: number }
export interface ProviderOrder { orderId: string; phone: string }

/** gone = provider tidak lagi mengenal order (WRONG/INVALID ORDER ID): umumnya sudah dibatalkan/kedaluwarsa di sisi provider */
export type OrderState = 'waiting' | 'received' | 'cancel' | 'done' | 'gone' | 'unknown';
export interface ProviderStatus { state: OrderState; sms: string | null; raw: string }

export interface OtpApi {
  getCountries(): Promise<Country[]>;
  getOperators(countryId: string): Promise<Operator[]>;
  getServices(countryId: string): Promise<Service[]>;
  getOrder(p: { operatorId: string; serviceId: string; countryId: string }, orderRef?: string): Promise<ProviderOrder>;
  getStatus(providerOrderId: string): Promise<ProviderStatus>;
  setStatus(providerOrderId: string, status: 2 | 3 | 4): Promise<void>;
}

/** Menerima true/"true"/"TRUE"/1 sebagai sukses; false/"false"/0 sebagai gagal; selain itu undefined. */
export function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return undefined;
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const pick = (o: Record<string, any>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** Lempar ProviderError kalau respons menandakan gagal. */
export function assertOk(body: unknown): Record<string, any> | any[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') throw new ProviderError('Respons provider tidak valid', false);
  const b = body as Record<string, any>;
  const ok = parseBool(b.status);
  if (ok === false) throw new ProviderError(String(b.msg ?? b.message ?? 'Provider menolak'), true);
  if (ok === undefined && typeof b.msg === 'string' && (PROVIDER_ERRORS as readonly string[]).some((e) => e.toLowerCase() === b.msg.trim().toLowerCase())) {
    throw new ProviderError(b.msg, true);
  }
  return b;
}

function listOf(body: unknown): any[] {
  const r = assertOk(body);
  if (Array.isArray(r)) return r;
  const l = pick(r, ['data', 'result', 'results', 'countries', 'operators', 'services', 'list']);
  if (Array.isArray(l)) return l;
  if (l && typeof l === 'object') {
    // bentuk map: { "1": {name...}, ... }
    return Object.entries(l as Record<string, any>).map(([k, v]) => (typeof v === 'object' ? { id: k, ...v } : { id: k, name: v }));
  }
  return [];
}

export function parseCountries(body: unknown): Country[] {
  return listOf(body).flatMap((x) => {
    const id = str(pick(x, ['id', 'countryID', 'country_id', 'code']));
    const name = str(pick(x, ['name', 'countryName', 'country_name', 'country', 'title']));
    return id && name ? [{ id, name }] : [];
  });
}

export function parseOperators(body: unknown): Operator[] {
  return listOf(body).flatMap((x) => {
    if (typeof x === 'string') return x ? [{ id: x, name: x }] : []; // operator berupa array string
    const id = str(pick(x, ['id', 'operatorID', 'operator_id', 'code']));
    const name = str(pick(x, ['name', 'operatorName', 'operator_name', 'operator', 'title']));
    return id ? [{ id, name: name ?? id }] : [];
  });
}

export function parseServices(body: unknown): Service[] {
  return listOf(body).flatMap((x) => {
    const id = str(pick(x, ['id', 'serviceID', 'service_id', 'code']));
    const name = str(pick(x, ['name', 'serviceName', 'service_name', 'service', 'title']));
    const price = toInt(pick(x, ['price', 'harga', 'cost']));
    return id && name && price !== null && price > 0 ? [{ id, name, price }] : [];
  });
}

export function parseProviderOrder(body: unknown): ProviderOrder {
  const r = assertOk(body);
  const o = (Array.isArray(r) ? r[0] : (r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? { ...r, ...r.data } : r)) as Record<string, any>;
  const orderId = str(pick(o, ['order_id', 'orderID', 'id', 'orderId']));
  const phone = str(pick(o, ['number', 'phone', 'phone_number', 'phoneNumber', 'phoneNum', 'nomor']));
  if (!orderId || !phone) throw new ProviderError(`Provider tidak mengembalikan nomor: ${JSON.stringify(body).slice(0, 200)}`, false);
  return { orderId, phone };
}

export const isOrderGone = (msg: string) => /^(wrong|invalid) order id$/i.test(msg.trim());

export function normalizeState(raw: string): OrderState {
  const s = raw.trim().toLowerCase();
  if (s === 'waiting sms' || s === 'waiting' || s === 'wait') return 'waiting';
  if (s === 'recieved' || s === 'received') return 'received';
  if (s === 'cancel' || s === 'canceled' || s === 'cancelled') return 'cancel';
  if (s === 'done' || s === 'finish' || s === 'finished') return 'done';
  return 'unknown';
}

export function parseStatus(body: unknown): ProviderStatus {
  const r = assertOk(body);
  const o = (Array.isArray(r) ? r[0] : r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? { ...r, ...r.data } : r) as Record<string, any>;
  const candidates = ['status_order', 'order_status', 'state', 'status', 'msg', 'message']
    .map((k) => o[k])
    .filter((v): v is string => typeof v === 'string' && parseBool(v) === undefined);
  let raw = '';
  let state: OrderState = 'unknown';
  for (const c of candidates) {
    const st = normalizeState(c);
    if (st !== 'unknown') { state = st; raw = c; break; }
    raw ||= c;
  }
  const sms = str(pick(o, ['sms', 'otp', 'code', 'sms_text', 'text']));
  if (state === 'waiting' && sms) state = 'received';
  return { state, sms, raw };
}

export class OtpClient implements OtpApi {
  constructor(private baseUrl: string, private apiKey: string) {}

  private async call(action: string, params: Record<string, string>, opts: { retries?: number; orderId?: string } = {}): Promise<unknown> {
    const q = new URLSearchParams({ api_key: this.apiKey, action, ...params });
    try {
      return await httpJson(`${this.baseUrl}?${q.toString()}`, { label: `otp.${action}`, retries: opts.retries ?? 0, orderId: opts.orderId, acceptErrorJson: true });
    } catch (e) {
      if (e instanceof HttpError) {
        // HTTP error dari provider kadang membawa pesan di body
        throw new ProviderError(e.message, e.definite);
      }
      throw e;
    }
  }

  async getCountries() { return parseCountries(await this.call('getCountries', {}, { retries: 2 })); }
  async getOperators(countryId: string) { return parseOperators(await this.call('getOperators', { country_id: countryId }, { retries: 2 })); }
  async getServices(countryId: string) { return parseServices(await this.call('getServices', { country_id: countryId }, { retries: 2 })); }

  /** Tanpa retry otomatis: risiko beli ganda. */
  async getOrder(p: { operatorId: string; serviceId: string; countryId: string }, orderRef?: string) {
    const body = await this.call('get_order', { operator_id: p.operatorId, service_id: p.serviceId, country_id: p.countryId }, { orderId: orderRef });
    logger.info({ orderId: orderRef, body: maskSecrets(JSON.stringify(body).slice(0, 500)) }, 'respons get_order');
    return parseProviderOrder(body);
  }

  async getStatus(providerOrderId: string): Promise<ProviderStatus> {
    try {
      return parseStatus(await this.call('get_status', { order_id: providerOrderId }, { retries: 1 }));
    } catch (e) {
      if (e instanceof ProviderError && isOrderGone(e.message)) return { state: 'gone', sms: null, raw: e.message };
      throw e;
    }
  }

  async setStatus(providerOrderId: string, status: 2 | 3 | 4) {
    assertOk(await this.call('set_status', { order_id: providerOrderId, status: String(status) }));
  }
}

import { vi } from 'vitest';
import { ProviderError, type OtpApi, type ProviderStatus } from '../src/clients/otp.js';
import { SaldoError, type SaldoApi, type SaldoUser } from '../src/clients/saldo.js';
import { Catalog } from '../src/services/catalog.js';
import { OrderService } from '../src/services/orderService.js';
import { TERMINAL_STATUSES, ACTIVE_STATUSES, type Messenger, type NewOrder, type OrderPatch, type OrderRow, type OrderStatus, type OrderStore, type SettingsApi } from '../src/services/types.js';

export class MemoryStore implements OrderStore {
  rows = new Map<string, OrderRow>();
  events: { id: string; from: string | null; to: string }[] = [];
  private seq = 0;

  async create(d: NewOrder) {
    const id = `o${++this.seq}`;
    const row: OrderRow = {
      dmChannelId: null, dmMessageId: null, ...d, id, providerOrderId: null, phoneNumber: null, smsText: null, status: 'PENDING_PAYMENT',
      expiresAt: null, refundedAt: null, failReason: null, cancelAttempts: 0, refundAttempts: 0, nextRetryAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    this.rows.set(id, row);
    return { ...row };
  }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : null; }
  async update(id: string, patch: OrderPatch) {
    const r = this.rows.get(id)!;
    if (patch.status && patch.status !== r.status) this.events.push({ id, from: r.status, to: patch.status });
    Object.assign(r, patch);
    return { ...r };
  }
  async transition(id: string, from: OrderStatus[], patch: OrderPatch) {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return null;
    return this.update(id, patch);
  }
  async claimRefund(id: string, at: Date) {
    await Promise.resolve();
    const r = this.rows.get(id)!;
    if (r.refundedAt) return false;
    r.refundedAt = at;
    return true;
  }
  async releaseRefund(id: string) { this.rows.get(id)!.refundedAt = null; }
  async listByStatus(s: OrderStatus[]) { return [...this.rows.values()].filter((r) => s.includes(r.status)).map((r) => ({ ...r })); }
  async countActive(d: string) { return [...this.rows.values()].filter((r) => r.discordId === d && ACTIVE_STATUSES.includes(r.status)).length; }
  async recent(d: string, n: number) { return [...this.rows.values()].filter((r) => r.discordId === d).slice(-n).map((r) => ({ ...r })); }
  async listDanglingRefundClaims() {
    return [...this.rows.values()].filter((r) => r.refundedAt && !TERMINAL_STATUSES.includes(r.status) && r.status !== 'NEEDS_REVIEW').map((r) => ({ ...r }));
  }
}

export class FakeSaldo implements SaldoApi {
  user: SaldoUser | null = { discordId: 'u1', balanceRupiah: 100_000, isBlacklisted: false };
  calls: { action: string; amountRp: number; description: string }[] = [];
  failAdd: 'no' | 'definite' | 'ambiguous' = 'no';
  failDeduct: 'no' | 'definite' | 'ambiguous' = 'no';
  async checkUser() { return this.user; }
  async adjust(p: { action: 'deduct' | 'add'; amountRp: number; description: string }) {
    await Promise.resolve();
    const fail = p.action === 'add' ? this.failAdd : this.failDeduct;
    if (fail !== 'no') throw new SaldoError('boom', fail === 'definite');
    this.calls.push({ action: p.action, amountRp: p.amountRp, description: p.description });
    if (this.user) this.user.balanceRupiah += p.action === 'add' ? p.amountRp : -p.amountRp;
  }
  count(action: string) { return this.calls.filter((c) => c.action === action).length; }
}

export class FakeOtp implements OtpApi {
  status: ProviderStatus = { state: 'waiting', sms: null, raw: 'Waiting SMS' };
  /** state yang dipakai setelah set_status 2 sukses */
  cancelWorks = true;
  getOrderError: ProviderError | Error | null = null;
  statusError = false;
  setCalls: number[] = [];
  getOrderCalls = 0;
  async getCountries() { return [{ id: '6', name: 'Indonesia' }]; }
  async getOperators() { return [{ id: 'any', name: 'Any' }]; }
  async getServices() { return [{ id: 'wa', name: 'WhatsApp', price: 2000 }]; }
  async getOrder() {
    this.getOrderCalls++;
    if (this.getOrderError) throw this.getOrderError;
    return { orderId: 'P1', phone: '+628111' };
  }
  async getStatus() {
    if (this.statusError) throw new Error('status down');
    return this.status;
  }
  async setStatus(_id: string, s: 2 | 3 | 4) {
    this.setCalls.push(s);
    if (s === 2 && this.cancelWorks) this.status = { state: 'cancel', sms: null, raw: 'Cancel' };
  }
}

export const fakeSettings: SettingsApi & { maintenance: boolean } = {
  maintenance: false,
  getMarkupGlobal: async () => 1000,
  getMarkupForService: async () => 1000,
  getMarkups: async () => ({ global: 1000, overrides: {} }),
  getTimeoutMinutes: async () => 5,
  isMaintenance: async function () { return this.maintenance; },
};

export function setup(opts: { now?: () => Date } = {}) {
  const store = new MemoryStore();
  const saldo = new FakeSaldo();
  const otp = new FakeOtp();
  const settings = { ...fakeSettings, maintenance: false } as typeof fakeSettings;
  const notified: string[] = [];
  const messenger: Messenger = {
    openOrderMessage: vi.fn(async () => ({ channelId: 'dm1', messageId: 'm1' })),
    refresh: vi.fn(async () => {}),
    sendOtp: vi.fn(async () => {}),
  };
  const notifier = { notifyOwner: async (t: string) => { notified.push(t); } };
  const catalog = new Catalog(otp, settings);
  const orders = new OrderService({ store, saldo, otp, catalog, settings, messenger, notifier, maxActiveOrders: 3, now: opts.now });
  const params = { discordId: 'u1', countryId: '6', operatorId: 'any', serviceId: 'wa', expectedPrice: 3000 };
  return { store, saldo, otp, settings, messenger, notified, catalog, orders, params };
}

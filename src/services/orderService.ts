import { ProviderError, type OtpApi } from '../clients/otp.js';
import { SaldoError, type SaldoApi } from '../clients/saldo.js';
import { logger } from '../logger.js';
import { KeyedMutex } from '../util/mutex.js';
import { extractCode } from '../util/format.js';
import type { Catalog } from './catalog.js';
import { effectiveMarkup } from './pricing.js';
import {
  REFUNDABLE_STATUSES, type ActivityKind, type ActivityLog, type Messenger, type Notifier, type OrderRow, type OrderStore, type SettingsApi,
} from './types.js';

export const MAX_CANCEL_ATTEMPTS = 5;
export const MAX_REFUND_ATTEMPTS = 8;
const REFUND_ALERT_AFTER = 3;

export type PurchaseCode =
  | 'MAINTENANCE' | 'BUSY' | 'USER_NOT_FOUND' | 'USER_CHECK_FAILED' | 'BLACKLISTED' | 'INSUFFICIENT' | 'DM_CLOSED'
  | 'TOO_MANY_ACTIVE' | 'SERVICE_GONE' | 'PRICE_CHANGED' | 'FAILED' | 'FAILED_REFUNDED' | 'NEEDS_REVIEW';

export type PurchaseResult =
  | { ok: true; order: OrderRow }
  | { ok: false; code: PurchaseCode; message: string; newPrice?: number; order?: OrderRow };

export interface PurchaseParams {
  discordId: string;
  countryId: string;
  operatorId: string;
  serviceId: string;
  /** harga final yang dilihat user saat konfirmasi */
  expectedPrice: number;
}

export interface OrderServiceDeps {
  store: OrderStore;
  saldo: SaldoApi;
  otp: OtpApi;
  catalog: Catalog;
  settings: SettingsApi;
  messenger: Messenger;
  notifier: Notifier;
  activity?: ActivityLog;
  maxActiveOrders: number;
  /** tombol/permintaan Batalkan dari user baru valid setelah sekian menit sejak order dibuat */
  cancelMinMinutes?: number;
  now?: () => Date;
}

const fail = (code: PurchaseCode, message: string, extra: Partial<Extract<PurchaseResult, { ok: false }>> = {}): PurchaseResult => ({ ok: false, code, message, ...extra });

export class OrderService {
  private locks = new KeyedMutex();
  private buying = new Set<string>();
  private unlockRefreshed = new Set<string>();
  private now: () => Date;

  constructor(private d: OrderServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ---------- helpers ----------

  private async safe(label: string, fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { logger.warn({ label, err: e instanceof Error ? e.message : String(e) }, 'operasi best-effort gagal'); }
  }

  private async refresh(o: OrderRow) { await this.safe('messenger.refresh', () => this.d.messenger.refresh(o)); }
  private log(kind: ActivityKind, o: OrderRow) { return this.safe('activity', () => this.d.activity?.record(kind, o) ?? Promise.resolve()); }
  private notify(text: string) { return this.safe('notify', () => this.d.notifier.notifyOwner(text)); }

  // ---------- pembelian ----------

  async purchase(p: PurchaseParams): Promise<PurchaseResult> {
    if (this.buying.has(p.discordId)) return fail('BUSY', 'Pesananmu sebelumnya masih diproses. Tunggu sebentar ya.');
    this.buying.add(p.discordId);
    try {
      return await this.doPurchase(p);
    } finally {
      this.buying.delete(p.discordId);
    }
  }

  private async doPurchase(p: PurchaseParams): Promise<PurchaseResult> {
    const { store, saldo, otp, catalog, settings, messenger } = this.d;

    if (await settings.isMaintenance()) return fail('MAINTENANCE', 'Pembelian sedang ditutup sementara.');

    // 1. user, blacklist, saldo (cek awal)
    let user;
    try {
      user = await saldo.checkUser(p.discordId);
    } catch (e) {
      logger.error({ err: String(e) }, 'cek user gagal');
      await this.notify('⚠️ API saldo tidak merespons saat cek user.');
      return fail('USER_CHECK_FAILED', 'Saldo belum bisa dicek. Coba lagi sebentar lagi.');
    }
    if (!user) return fail('USER_NOT_FOUND', 'Akunmu belum terdaftar di sistem saldo.');
    if (user.isBlacklisted) return fail('BLACKLISTED', 'Akunmu tidak bisa melakukan pembelian.');

    // 2. harga dihitung ulang dari data segar provider
    let countries, operators, services;
    try {
      [countries, operators, services] = await Promise.all([
        catalog.countries(), catalog.operators(p.countryId), catalog.services(p.countryId, true),
      ]);
    } catch (e) {
      logger.error({ err: String(e) }, 'katalog provider gagal');
      await this.notify('⚠️ API OTPCepat tidak merespons saat konfirmasi pembelian.');
      return fail('FAILED', 'Layanan sedang bermasalah. Saldomu tidak terpotong, coba lagi nanti.');
    }
    const country = countries.find((c) => c.id === p.countryId);
    const operator = operators.find((o) => o.id === p.operatorId);
    const svc = services.find((s) => s.id === p.serviceId);
    if (!country || !operator || !svc) return fail('SERVICE_GONE', 'Service ini sudah tidak tersedia. Pilih yang lain ya.');
    if (svc.finalPrice !== p.expectedPrice) {
      return fail('PRICE_CHANGED', 'Harga berubah. Cek harga baru lalu konfirmasi ulang.', { newPrice: svc.finalPrice });
    }
    const price = svc.finalPrice;
    if (user.balanceRupiah < price) return fail('INSUFFICIENT', 'Saldomu tidak cukup.');

    // 3. batas order aktif
    if ((await store.countActive(p.discordId)) >= this.d.maxActiveOrders) {
      return fail('TOO_MANY_ACTIVE', `Kamu sudah punya ${this.d.maxActiveOrders} order aktif. Selesaikan dulu salah satunya.`);
    }

    // 4. DM harus bisa dikirim (sebelum potong saldo)
    let dm;
    try {
      dm = await messenger.openOrderMessage(p.discordId);
    } catch {
      return fail('DM_CLOSED', 'Aku tidak bisa kirim DM ke kamu. Buka DM dari anggota server (Pengaturan Privasi) lalu coba lagi.');
    }

    // 5. buat order
    const markup = effectiveMarkup(svc.markup);
    let order = await store.create({
      discordId: p.discordId, countryId: country.id, countryName: country.name, operatorId: operator.id, operatorName: operator.name,
      serviceId: svc.id, serviceName: svc.name, providerPrice: svc.price, markup, paidAmount: price,
      dmChannelId: dm.channelId, dmMessageId: dm.messageId,
    });

    // 6. potong saldo
    try {
      await saldo.adjust({ discordId: p.discordId, action: 'deduct', amountRp: price, description: `Beli OTP #${order.id} (${svc.name})`, orderId: order.id });
    } catch (e) {
      const definite = e instanceof SaldoError && e.definite;
      if (definite) {
        order = await store.update(order.id, { status: 'FAILED', failReason: `deduct ditolak: ${(e as Error).message}` });
        await this.refresh(order);
        await this.log('FAILED', order);
        return fail('FAILED', 'Saldo gagal dipotong, pesanan dibatalkan. Tidak ada yang terpotong.', { order });
      }
      // tidak pasti apakah saldo terpotong: jangan refund tanpa bukti
      order = await store.update(order.id, { status: 'NEEDS_REVIEW', failReason: `deduct tidak pasti: ${(e as Error).message}` });
      await this.notify(`⚠️ Order ${order.id} NEEDS_REVIEW: potong saldo tidak pasti (timeout/jaringan). User <@${order.discordId}>, Rp${price}.`);
      await this.refresh(order);
      await this.log('REVIEW', order);
      return fail('NEEDS_REVIEW', 'Terjadi gangguan saat memotong saldo. Pesananmu sedang dicek admin, saldo akan dikembalikan jika ternyata terpotong.', { order });
    }
    order = await store.update(order.id, { status: 'PAID' });

    // 7. pesan nomor ke provider (tanpa retry otomatis)
    try {
      const po = await otp.getOrder({ operatorId: operator.id, serviceId: svc.id, countryId: country.id }, order.id);
      const timeout = await settings.getTimeoutMinutes();
      order = await store.update(order.id, {
        status: 'WAITING_SMS', providerOrderId: po.orderId, phoneNumber: po.phone,
        expiresAt: new Date(this.now().getTime() + timeout * 60_000),
      }, 'nomor didapat');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ProviderError && e.noBalance) {
        await this.notify('🚨 Saldo akun OTPCepat habis (NO BALANCE). Top up secepatnya. Pembelian user sudah di-refund otomatis.');
      }
      order = (await store.update(order.id, { failReason: `get_order gagal: ${msg}` }));
      const r = await this.refund(order.id);
      order = (await store.get(order.id))!;
      if (r === 'REFUNDED') {
        return fail('FAILED_REFUNDED', 'Nomor gagal didapat. Saldomu sudah dikembalikan utuh.', { order });
      }
      return fail('FAILED', 'Nomor gagal didapat. Saldomu akan dikembalikan otomatis dalam beberapa saat.', { order });
    }

    await this.refresh(order);
    await this.log('PURCHASED', order);
    return { ok: true, order };
  }

  // ---------- selesai ----------

  /** Dipanggil di dalam lock. */
  private async completeLocked(o: OrderRow, sms: string | null): Promise<OrderRow | null> {
    const done = await this.d.store.transition(o.id, ['WAITING_SMS', 'CANCEL_PENDING'], { status: 'COMPLETED', smsText: sms ?? o.smsText, nextRetryAt: null }, 'SMS diterima');
    if (!done) return null;
    await this.refresh(done);
    await this.log('COMPLETED', done);
    await this.safe('sendOtp', () => this.d.messenger.sendOtp(done, done.smsText ? extractCode(done.smsText) : null));
    if (done.providerOrderId) await this.safe('set_status finish', () => this.d.otp.setStatus(done.providerOrderId!, 4));
    return done;
  }

  /** SMS terdeteksi oleh poller. */
  async handleSms(orderId: string, sms: string | null): Promise<boolean> {
    return this.locks.run(orderId, async () => {
      const o = await this.d.store.get(orderId);
      if (!o) return false;
      return (await this.completeLocked(o, sms)) !== null;
    });
  }

  // ---------- cancel + refund ----------

  async cancelOrder(orderId: string, reason: 'timeout' | 'user' | 'provider' | 'retry'): Promise<'COMPLETED' | 'REFUNDED' | 'PENDING' | 'REVIEW' | 'SKIPPED'> {
    return this.locks.run(orderId, async () => {
      const { store, otp } = this.d;
      const o = await store.get(orderId);
      if (!o || (o.status !== 'WAITING_SMS' && o.status !== 'CANCEL_PENDING')) return 'SKIPPED';
      if (!o.providerOrderId) return (await this.refundLocked(o.id)) === 'REFUNDED' ? 'REFUNDED' : 'PENDING';

      // 1. cek dulu: kalau SMS sudah masuk, jangan cancel/refund
      let st;
      try {
        st = await otp.getStatus(o.providerOrderId);
      } catch (e) {
        return this.cancelUnclear(o, `get_status gagal: ${(e as Error).message}`);
      }
      if (st.state === 'received' || st.state === 'done') {
        return (await this.completeLocked(o, st.sms)) ? 'COMPLETED' : 'SKIPPED';
      }
      if (st.state === 'unknown') logger.warn({ orderId, raw: st.raw }, 'status provider tidak dikenal (cancel)');

      // 2. cancel di provider (order yang sudah tidak dikenal provider dianggap sudah batal)
      if (st.state !== 'cancel' && st.state !== 'gone') {
        try {
          await otp.setStatus(o.providerOrderId, 2);
        } catch (e) {
          logger.warn({ orderId, err: (e as Error).message }, 'set_status cancel gagal, verifikasi ulang');
        }
        // 3. verifikasi
        let st2;
        try {
          st2 = await otp.getStatus(o.providerOrderId);
        } catch (e) {
          return this.cancelUnclear(o, `verifikasi cancel gagal: ${(e as Error).message}`);
        }
        if (st2.state === 'received' || st2.state === 'done') {
          return (await this.completeLocked(o, st2.sms)) ? 'COMPLETED' : 'SKIPPED';
        }
        if (st2.state !== 'cancel' && st2.state !== 'gone') return this.cancelUnclear(o, `status setelah cancel: ${st2.raw || st2.state}`);
      }

      // 4. cancel terverifikasi -> refund
      logger.info({ orderId, reason, providerState: st.state }, 'cancel terverifikasi, refund');
      const r = await this.refundLocked(o.id);
      return r === 'REFUNDED' ? 'REFUNDED' : 'PENDING';
    });
  }

  private async cancelUnclear(o: OrderRow, why: string): Promise<'PENDING' | 'REVIEW'> {
    const attempts = o.cancelAttempts + 1;
    if (attempts >= MAX_CANCEL_ATTEMPTS) {
      const upd = await this.d.store.update(o.id, { status: 'NEEDS_REVIEW', cancelAttempts: attempts, failReason: why, nextRetryAt: null }, why);
      await this.notify(`⚠️ Order ${o.id} NEEDS_REVIEW: cancel di provider tidak terverifikasi setelah ${attempts}x (${why}). Nomor ${o.phoneNumber}, provider order ${o.providerOrderId}.`);
      await this.refresh(upd);
      await this.log('REVIEW', upd);
      return 'REVIEW';
    }
    const upd = await this.d.store.update(o.id, {
      status: 'CANCEL_PENDING', cancelAttempts: attempts, failReason: why,
      nextRetryAt: new Date(this.now().getTime() + 15_000 * attempts),
    }, why);
    await this.refresh(upd);
    return 'PENDING';
  }

  /** Refund idempotent. Aman dipanggil berulang dan paralel. */
  async refund(orderId: string): Promise<'REFUNDED' | 'FAILED' | 'SKIPPED'> {
    return this.locks.run(orderId, () => this.refundLocked(orderId));
  }

  private async refundLocked(orderId: string): Promise<'REFUNDED' | 'FAILED' | 'SKIPPED'> {
    const { store, saldo } = this.d;
    const o = await store.get(orderId);
    if (!o || o.refundedAt || !REFUNDABLE_STATUSES.includes(o.status)) return 'SKIPPED';
    const finalStatus = o.providerOrderId ? 'REFUNDED' : 'FAILED_REFUNDED';

    // tandai SEBELUM memanggil API saldo
    if (!(await store.claimRefund(o.id, this.now()))) return 'SKIPPED';
    try {
      await saldo.adjust({ discordId: o.discordId, action: 'add', amountRp: o.paidAmount, description: `Refund OTP #${o.id} (${o.serviceName})`, orderId: o.id });
    } catch (e) {
      await store.releaseRefund(o.id);
      const attempts = o.refundAttempts + 1;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempts >= MAX_REFUND_ATTEMPTS) {
        const upd = await store.update(o.id, { status: 'NEEDS_REVIEW', refundAttempts: attempts, failReason: `refund gagal: ${msg}`, nextRetryAt: null }, 'refund gagal berulang');
        await this.notify(`🚨 Refund order ${o.id} gagal ${attempts}x (<@${o.discordId}>, Rp${o.paidAmount}): ${msg}. Perlu ditangani manual.`);
        await this.refresh(upd);
        await this.log('REVIEW', upd);
        return 'FAILED';
      }
      const upd = await store.update(o.id, {
        status: 'REFUND_FAILED', refundAttempts: attempts, failReason: `refund gagal: ${msg}`,
        nextRetryAt: new Date(this.now().getTime() + Math.min(300, 10 * 2 ** attempts) * 1000),
      }, 'refund gagal, akan dicoba lagi');
      if (attempts === REFUND_ALERT_AFTER) {
        await this.notify(`⚠️ Refund order ${o.id} gagal ${attempts}x (<@${o.discordId}>, Rp${o.paidAmount}). Masih dicoba otomatis.`);
      }
      await this.refresh(upd);
      return 'FAILED';
    }

    const done = await store.update(o.id, { status: finalStatus, nextRetryAt: null }, 'refund berhasil');
    await this.refresh(done);
    await this.log('REFUNDED', done);
    return 'REFUNDED';
  }

  // ---------- aksi user dari DM ----------

  private cancelUnlockAt(o: OrderRow): Date {
    return new Date(o.createdAt.getTime() + (this.d.cancelMinMinutes ?? 5) * 60_000);
  }

  /** Dipanggil worker: render ulang DM sekali saat tombol Batalkan sudah aktif. */
  async refreshIfCancelUnlocked(o: OrderRow): Promise<void> {
    if (o.status !== 'WAITING_SMS' || this.unlockRefreshed.has(o.id) || this.now() < this.cancelUnlockAt(o)) return;
    this.unlockRefreshed.add(o.id);
    await this.refresh(o);
  }

  /** Refund manual oleh owner untuk order NEEDS_REVIEW. Tetap idempotent lewat refundedAt. */
  async adminRefund(orderId: string): Promise<{ ok: boolean; message: string }> {
    return this.locks.run(orderId, async () => {
      const o = await this.d.store.get(orderId);
      if (!o) return { ok: false, message: 'Order tidak ditemukan.' };
      if (o.refundedAt) return { ok: false, message: 'Order ini sudah pernah di-refund (atau refund sedang berjalan). Cek log saldo user.' };
      if (o.status !== 'NEEDS_REVIEW') return { ok: false, message: `Hanya order NEEDS_REVIEW yang bisa di-refund manual (status sekarang: ${o.status}).` };
      await this.d.store.transition(o.id, ['NEEDS_REVIEW'], { status: 'REFUND_FAILED', nextRetryAt: null, refundAttempts: 0 }, 'refund manual oleh admin');
      const r = await this.refundLocked(o.id);
      if (r === 'REFUNDED') return { ok: true, message: `Refund ${o.paidAmount} berhasil untuk <@${o.discordId}>.` };
      return { ok: false, message: 'Refund gagal ke API saldo. Order berstatus REFUND_FAILED dan akan dicoba ulang otomatis.' };
    });
  }

  async userCancel(orderId: string, discordId: string): Promise<{ ok: boolean; message: string }> {
    const o = await this.d.store.get(orderId);
    if (!o || o.discordId !== discordId) return { ok: false, message: 'Order tidak ditemukan.' };
    if (o.status !== 'WAITING_SMS') return { ok: false, message: 'Order ini sudah tidak bisa dibatalkan.' };
    const unlock = this.cancelUnlockAt(o);
    if (this.now() < unlock) {
      return { ok: false, message: `Pembatalan baru bisa dilakukan <t:${Math.floor(unlock.getTime() / 1000)}:R>. Kalau SMS tidak masuk, order dibatalkan otomatis dan saldo dikembalikan.` };
    }
    const r = await this.cancelOrder(orderId, 'user');
    switch (r) {
      case 'REFUNDED': return { ok: true, message: 'Order dibatalkan dan saldo sudah dikembalikan.' };
      case 'COMPLETED': return { ok: true, message: 'SMS ternyata sudah masuk, jadi order tidak dibatalkan.' };
      case 'PENDING': return { ok: true, message: 'Pembatalan sedang diproses. Saldo dikembalikan otomatis begitu terverifikasi.' };
      case 'REVIEW': return { ok: true, message: 'Pembatalan perlu dicek admin. Saldomu aman, tunggu kabar ya.' };
      default: return { ok: false, message: 'Order ini sudah tidak bisa dibatalkan.' };
    }
  }
}

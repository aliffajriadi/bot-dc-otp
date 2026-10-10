import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/clients/otp.js';
import { recoverOrders } from '../src/services/recovery.js';
import { PollWorker } from '../src/services/worker.js';
import { setup } from './helpers.js';

async function bought(ctx = setup()) {
  const r = await ctx.orders.purchase(ctx.params);
  if (!r.ok) throw new Error('purchase gagal: ' + r.code);
  return { ...ctx, order: r.order };
}

describe('pembelian', () => {
  it('sukses: saldo terpotong sekali, WAITING_SMS', async () => {
    const { saldo, order, store } = await bought();
    expect(saldo.count('deduct')).toBe(1);
    expect(saldo.calls[0]).toMatchObject({ amountRp: 3000 });
    expect(saldo.calls[0]!.description).toContain(order.id);
    expect((await store.get(order.id))!.status).toBe('WAITING_SMS');
    expect(order.expiresAt).toBeTruthy();
  });

  it('harga berubah -> minta konfirmasi ulang, saldo tidak terpotong', async () => {
    const c = setup();
    const r = await c.orders.purchase({ ...c.params, expectedPrice: 2500 });
    expect(r).toMatchObject({ ok: false, code: 'PRICE_CHANGED', newPrice: 3000 });
    expect(c.saldo.calls).toHaveLength(0);
  });

  it('DM tertutup -> batal sebelum potong saldo', async () => {
    const c = setup();
    (c.messenger.openOrderMessage as any).mockRejectedValueOnce(new Error('Cannot send'));
    const r = await c.orders.purchase(c.params);
    expect(r).toMatchObject({ ok: false, code: 'DM_CLOSED' });
    expect(c.saldo.calls).toHaveLength(0);
  });

  it('blacklist, saldo kurang, maintenance, batas order aktif', async () => {
    let c = setup(); c.saldo.user!.isBlacklisted = true;
    expect(await c.orders.purchase(c.params)).toMatchObject({ code: 'BLACKLISTED' });
    c = setup(); c.saldo.user!.balanceRupiah = 100;
    expect(await c.orders.purchase(c.params)).toMatchObject({ code: 'INSUFFICIENT' });
    c = setup(); c.settings.maintenance = true;
    expect(await c.orders.purchase(c.params)).toMatchObject({ code: 'MAINTENANCE' });
    c = setup();
    for (let i = 0; i < 3; i++) expect((await c.orders.purchase(c.params)).ok).toBe(true);
    expect(await c.orders.purchase(c.params)).toMatchObject({ code: 'TOO_MANY_ACTIVE' });
    expect(c.saldo.count('deduct')).toBe(3);
  });

  it('klik ganda paralel hanya membuat satu order', async () => {
    const c = setup();
    const [a, b] = await Promise.all([c.orders.purchase(c.params), c.orders.purchase(c.params)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(c.saldo.count('deduct')).toBe(1);
  });

  it('get_order gagal setelah potong -> refund otomatis, tanpa retry get_order', async () => {
    const c = setup();
    c.otp.getOrderError = new ProviderError('NO BALANCE', true);
    const r = await c.orders.purchase(c.params);
    expect(r).toMatchObject({ ok: false, code: 'FAILED_REFUNDED' });
    expect(c.saldo.count('deduct')).toBe(1);
    expect(c.saldo.count('add')).toBe(1);
    expect(c.otp.getOrderCalls).toBe(1);
    expect(c.saldo.user!.balanceRupiah).toBe(100_000);
    expect(c.notified.some((n) => n.includes('NO BALANCE'))).toBe(true);
  });

  it('deduct ditolak jelas -> FAILED tanpa refund; deduct tidak pasti -> NEEDS_REVIEW tanpa refund', async () => {
    let c = setup(); c.saldo.failDeduct = 'definite';
    expect(await c.orders.purchase(c.params)).toMatchObject({ code: 'FAILED' });
    expect(c.saldo.count('add')).toBe(0);
    expect(c.otp.getOrderCalls).toBe(0);
    c = setup(); c.saldo.failDeduct = 'ambiguous';
    expect(await c.orders.purchase(c.params)).toMatchObject({ code: 'NEEDS_REVIEW' });
    expect(c.saldo.count('add')).toBe(0);
    expect(c.notified).toHaveLength(1);
  });
});

describe('sms, timeout, cancel, refund', () => {
  it('SMS masuk -> COMPLETED, tidak ada refund, set_status finish', async () => {
    const c = await bought();
    c.otp.status = { state: 'received', sms: 'Kode 123456', raw: 'Recieved' };
    const w = new PollWorker(c.store, c.otp, c.orders, 1000);
    await w.tick();
    const o = (await c.store.get(c.order.id))!;
    expect(o.status).toBe('COMPLETED');
    expect(o.smsText).toBe('Kode 123456');
    expect(c.saldo.count('add')).toBe(0);
    expect(c.otp.setCalls).toEqual([4]);
    expect(c.messenger.sendOtp).toHaveBeenCalledWith(expect.anything(), '123456');
  });

  it('timeout: cancel diverifikasi lalu refund tepat sekali', async () => {
    let now = new Date();
    const c = await bought(setup({ now: () => now }));
    now = new Date(now.getTime() + 6 * 60_000);
    const w = new PollWorker(c.store, c.otp, c.orders, 1000, () => now);
    await w.tick();
    await w.tick();
    const o = (await c.store.get(c.order.id))!;
    expect(o.status).toBe('REFUNDED');
    expect(c.saldo.count('add')).toBe(1);
    expect(c.otp.setCalls).toEqual([2]);
  });

  it('timeout tapi SMS ternyata sudah masuk -> tidak cancel, tidak refund', async () => {
    const c = await bought();
    c.otp.status = { state: 'received', sms: 'Kode 999111', raw: 'Recieved' };
    expect(await c.orders.cancelOrder(c.order.id, 'timeout')).toBe('COMPLETED');
    expect(c.otp.setCalls).not.toContain(2);
    expect(c.saldo.count('add')).toBe(0);
  });

  it('cancel tidak terverifikasi -> CANCEL_PENDING tanpa refund, lalu NEEDS_REVIEW', async () => {
    const c = await bought();
    c.otp.cancelWorks = false;
    expect(await c.orders.cancelOrder(c.order.id, 'user')).toBe('PENDING');
    expect((await c.store.get(c.order.id))!.status).toBe('CANCEL_PENDING');
    expect(c.saldo.count('add')).toBe(0);
    for (let i = 0; i < 4; i++) await c.orders.cancelOrder(c.order.id, 'retry');
    expect((await c.store.get(c.order.id))!.status).toBe('NEEDS_REVIEW');
    expect(c.saldo.count('add')).toBe(0);
    expect(c.notified.length).toBeGreaterThan(0);
  });

  it('refund paralel/berulang hanya memanggil API saldo sekali', async () => {
    const c = await bought();
    await c.orders.cancelOrder(c.order.id, 'user');
    const rs = await Promise.all([c.orders.refund(c.order.id), c.orders.refund(c.order.id), c.orders.refund(c.order.id)]);
    expect(rs.every((r) => r === 'SKIPPED')).toBe(true);
    expect(c.saldo.count('add')).toBe(1);
    // order COMPLETED tidak boleh di-refund
    const d = await bought();
    d.otp.status = { state: 'received', sms: 'x 1234', raw: 'Received' };
    await d.orders.handleSms(d.order.id, 'x 1234');
    expect(await d.orders.refund(d.order.id)).toBe('SKIPPED');
    expect(d.saldo.count('add')).toBe(0);
  });

  it('dua refund bersamaan dari status WAITING_SMS (race) -> sekali', async () => {
    const c = await bought();
    const rs = await Promise.all([c.orders.refund(c.order.id), c.orders.refund(c.order.id)]);
    expect(rs.filter((r) => r === 'REFUNDED')).toHaveLength(1);
    expect(c.saldo.count('add')).toBe(1);
  });

  it('refund gagal -> REFUND_FAILED, diulang otomatis oleh worker, lalu sukses sekali', async () => {
    let now = new Date();
    const c = await bought(setup({ now: () => now }));
    c.saldo.failAdd = 'definite';
    await c.orders.cancelOrder(c.order.id, 'user');
    let o = (await c.store.get(c.order.id))!;
    expect(o.status).toBe('REFUND_FAILED');
    expect(o.refundedAt).toBeNull();
    expect(o.nextRetryAt).toBeTruthy();
    c.saldo.failAdd = 'no';
    now = new Date(now.getTime() + 10 * 60_000);
    const w = new PollWorker(c.store, c.otp, c.orders, 1000, () => now);
    await w.tick();
    await w.tick();
    o = (await c.store.get(c.order.id))!;
    expect(o.status).toBe('REFUNDED');
    expect(c.saldo.count('add')).toBe(1);
  });

  it('refund gagal berulang -> NEEDS_REVIEW + notifikasi owner', async () => {
    const c = await bought();
    c.saldo.failAdd = 'definite';
    await c.orders.cancelOrder(c.order.id, 'user');
    for (let i = 0; i < 10; i++) await c.orders.refund(c.order.id);
    expect((await c.store.get(c.order.id))!.status).toBe('NEEDS_REVIEW');
    expect(c.notified.some((n) => n.includes('Refund order'))).toBe(true);
  });
});

describe('order hilang di provider', () => {
  it('WRONG ORDER ID saat cancel dianggap sudah batal -> refund sekali', async () => {
    const c = await bought();
    c.otp.status = { state: 'gone', sms: null, raw: 'WRONG ORDER ID' };
    expect(await c.orders.cancelOrder(c.order.id, 'timeout')).toBe('REFUNDED');
    expect(c.saldo.count('add')).toBe(1);
    expect(c.otp.setCalls).toEqual([]);
  });
  it('saat polling tidak langsung di-refund', async () => {
    const c = await bought();
    c.otp.status = { state: 'gone', sms: null, raw: 'WRONG ORDER ID' };
    await new PollWorker(c.store, c.otp, c.orders, 1000).tick();
    expect((await c.store.get(c.order.id))!.status).toBe('WAITING_SMS');
    expect(c.saldo.count('add')).toBe(0);
  });
});

describe('batal oleh user', () => {
  it('ditolak sebelum 5 menit, boleh setelahnya', async () => {
    let now = new Date();
    const c = await bought(setup({ now: () => now }));
    expect((await c.orders.userCancel(c.order.id, 'u1')).ok).toBe(false);
    expect((await c.store.get(c.order.id))!.status).toBe('WAITING_SMS');
    expect(c.otp.setCalls).toEqual([]);
    now = new Date(c.order.createdAt.getTime() + 5 * 60_000 + 1000);
    expect((await c.orders.userCancel(c.order.id, 'u1')).ok).toBe(true);
    expect((await c.store.get(c.order.id))!.status).toBe('REFUNDED');
  });
});

describe('adminRefund', () => {
  it('refund NEEDS_REVIEW tepat sekali; ditolak untuk status lain dan pemanggilan ulang', async () => {
    const c = await bought();
    expect((await c.orders.adminRefund(c.order.id)).ok).toBe(false); // masih WAITING_SMS
    await c.store.update(c.order.id, { status: 'NEEDS_REVIEW' });
    expect((await c.orders.adminRefund(c.order.id)).ok).toBe(true);
    expect((await c.orders.adminRefund(c.order.id)).ok).toBe(false);
    expect(c.saldo.count('add')).toBe(1);
    expect((await c.store.get(c.order.id))!.status).toBe('REFUNDED');
  });
  it('ditolak jika klaim refund sudah ada', async () => {
    const c = await bought();
    await c.store.update(c.order.id, { status: 'NEEDS_REVIEW', refundedAt: new Date() });
    expect((await c.orders.adminRefund(c.order.id)).ok).toBe(false);
    expect(c.saldo.count('add')).toBe(0);
  });
});

describe('recoverOrders', () => {
  const run = (c: ReturnType<typeof setup>) => recoverOrders({ store: c.store, orders: c.orders, notifier: { notifyOwner: async (t) => { c.notified.push(t); } }, settings: c.settings });

  it('PAID tanpa providerOrderId -> refund', async () => {
    const c = setup();
    const o = await c.store.create({ discordId: 'u1', countryId: '6', countryName: 'ID', operatorId: 'any', operatorName: 'Any', serviceId: 'wa', serviceName: 'WA', providerPrice: 2000, markup: 1000, paidAmount: 3000 });
    await c.store.update(o.id, { status: 'PAID' });
    await run(c);
    expect((await c.store.get(o.id))!.status).toBe('FAILED_REFUNDED');
    expect(c.saldo.count('add')).toBe(1);
  });

  it('PENDING_PAYMENT -> NEEDS_REVIEW tanpa refund', async () => {
    const c = setup();
    const o = await c.store.create({ discordId: 'u1', countryId: '6', countryName: 'ID', operatorId: 'any', operatorName: 'Any', serviceId: 'wa', serviceName: 'WA', providerPrice: 2000, markup: 1000, paidAmount: 3000 });
    await run(c);
    expect((await c.store.get(o.id))!.status).toBe('NEEDS_REVIEW');
    expect(c.saldo.calls).toHaveLength(0);
    expect(c.notified).toHaveLength(1);
  });

  it('WAITING_SMS kedaluwarsa -> cancel + refund; yang belum kedaluwarsa dilanjutkan', async () => {
    const c = await bought();
    const c2 = await bought(c);
    await c.store.update(c.order.id, { expiresAt: new Date(Date.now() - 1000) });
    const summary = await run(c);
    expect(summary).toMatchObject({ expired_cancelled: 1, waiting_resumed: 1 });
    expect((await c.store.get(c.order.id))!.status).toBe('REFUNDED');
    expect((await c.store.get(c2.order.id))!.status).toBe('WAITING_SMS');
    expect(c.saldo.count('add')).toBe(1);
  });

  it('REFUND_FAILED dilanjutkan; klaim refund menggantung -> NEEDS_REVIEW (tanpa refund ganda)', async () => {
    const c = await bought();
    c.saldo.failAdd = 'definite';
    await c.orders.cancelOrder(c.order.id, 'user');
    c.saldo.failAdd = 'no';
    await run(c);
    expect((await c.store.get(c.order.id))!.status).toBe('REFUNDED');

    const d = await bought();
    await d.store.update(d.order.id, { refundedAt: new Date() }); // crash setelah klaim
    await run(d);
    expect((await d.store.get(d.order.id))!.status).toBe('NEEDS_REVIEW');
    expect(d.saldo.count('add')).toBe(0);
  });

  it('dijalankan dua kali tidak menggandakan refund', async () => {
    const c = await bought();
    await c.store.update(c.order.id, { expiresAt: new Date(Date.now() - 1000) });
    await run(c);
    await run(c);
    expect(c.saldo.count('add')).toBe(1);
  });
});

describe('log aktivitas', () => {
  it('mencatat PURCHASED, COMPLETED, REFUNDED', async () => {
    const kinds: string[] = [];
    const c = setup();
    (c.orders as any).d.activity = { record: async (k: string) => { kinds.push(k); } };
    const r = await c.orders.purchase(c.params);
    if (!r.ok) throw new Error('gagal');
    await c.orders.handleSms(r.order.id, 'Kode 1234');
    const r2 = await c.orders.purchase(c.params);
    if (!r2.ok) throw new Error('gagal');
    await c.orders.refund(r2.order.id);
    expect(kinds).toEqual(['PURCHASED', 'COMPLETED', 'PURCHASED', 'REFUNDED']);
  });
});

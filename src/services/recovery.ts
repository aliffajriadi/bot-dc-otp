import { logger } from '../logger.js';
import type { OrderService } from './orderService.js';
import type { Notifier, OrderStore, SettingsApi } from './types.js';

/** Dijalankan saat bot start. */
export async function recoverOrders(d: { store: OrderStore; orders: OrderService; notifier: Notifier; settings: SettingsApi; now?: () => Date }) {
  const now = d.now?.() ?? new Date();
  const summary: Record<string, number> = {};
  const bump = (k: string) => { summary[k] = (summary[k] ?? 0) + 1; };

  // klaim refund menggantung: tidak diketahui apakah saldo sudah dikembalikan -> jangan refund lagi
  for (const o of await d.store.listDanglingRefundClaims()) {
    await d.store.update(o.id, { status: 'NEEDS_REVIEW', failReason: 'crash saat refund, status refund tidak diketahui' }, 'recovery: klaim refund menggantung');
    await d.notifier.notifyOwner(`⚠️ Order ${o.id} NEEDS_REVIEW: bot berhenti saat refund (<@${o.discordId}>, Rp${o.paidAmount}). Cek log saldo user untuk memastikan sudah/belum di-refund.`);
    bump('dangling_refund');
  }

  const rows = await d.store.listByStatus(['PENDING_PAYMENT', 'PAID', 'WAITING_SMS', 'CANCEL_PENDING', 'REFUND_FAILED']);
  for (const o of rows) {
    try {
      switch (o.status) {
        case 'PENDING_PAYMENT':
          await d.store.update(o.id, { status: 'NEEDS_REVIEW', failReason: 'crash sebelum pemotongan saldo terkonfirmasi' }, 'recovery');
          await d.notifier.notifyOwner(`⚠️ Order ${o.id} NEEDS_REVIEW: bot berhenti saat PENDING_PAYMENT (<@${o.discordId}>, Rp${o.paidAmount}). Cek apakah saldo user terpotong; refund manual jika iya.`);
          bump('pending_payment');
          break;
        case 'PAID':
          if (o.providerOrderId) {
            const timeout = await d.settings.getTimeoutMinutes();
            await d.store.update(o.id, { status: 'WAITING_SMS', expiresAt: o.expiresAt ?? new Date(now.getTime() + timeout * 60_000) }, 'recovery');
            bump('paid_with_provider_order');
          } else {
            await d.orders.refund(o.id);
            bump('paid_refunded');
          }
          break;
        case 'WAITING_SMS':
          if (!o.expiresAt || now >= o.expiresAt) { await d.orders.cancelOrder(o.id, 'timeout'); bump('expired_cancelled'); }
          else bump('waiting_resumed');
          break;
        case 'CANCEL_PENDING':
          await d.orders.cancelOrder(o.id, 'retry');
          bump('cancel_retried');
          break;
        case 'REFUND_FAILED':
          await d.orders.refund(o.id);
          bump('refund_retried');
          break;
      }
    } catch (e) {
      logger.error({ orderId: o.id, err: String(e) }, 'recovery order gagal');
    }
  }
  logger.info({ summary }, 'recoverOrders selesai');
  return summary;
}

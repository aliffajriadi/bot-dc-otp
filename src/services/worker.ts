import { logger } from '../logger.js';
import type { OtpApi } from '../clients/otp.js';
import type { OrderService } from './orderService.js';
import type { OrderStore } from './types.js';

/** Satu loop untuk semua order aktif (bukan satu timer per order). */
export class PollWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private store: OrderStore,
    private otp: OtpApi,
    private orders: OrderService,
    private intervalMs: number,
    private now: () => Date = () => new Date(),
    private concurrency = 4,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Satu siklus; tidak menumpuk kalau siklus sebelumnya belum selesai. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const t = this.now();
      const waiting = await this.store.listByStatus(['WAITING_SMS']);
      const retryable = (await this.store.listByStatus(['CANCEL_PENDING', 'REFUND_FAILED'])).filter((o) => !o.nextRetryAt || o.nextRetryAt <= t);
      const jobs: (() => Promise<void>)[] = [];

      for (const o of waiting) {
        jobs.push(async () => {
          if (!o.expiresAt || t >= o.expiresAt) { await this.orders.cancelOrder(o.id, 'timeout'); return; }
          if (!o.providerOrderId) return;
          await this.orders.refreshIfCancelUnlocked(o);
          try {
            const st = await this.otp.getStatus(o.providerOrderId);
            if (st.state === 'received' || st.state === 'done') await this.orders.handleSms(o.id, st.sms);
            else if (st.state === 'cancel') await this.orders.cancelOrder(o.id, 'provider');
            else if (st.state === 'gone') logger.warn({ orderId: o.id, raw: st.raw }, 'provider tidak mengenal order ini (WRONG ORDER ID); diselesaikan saat timeout')
            else if (st.state === 'unknown') logger.warn({ orderId: o.id, raw: st.raw }, 'status provider tidak dikenal');
          } catch (e) {
            logger.warn({ orderId: o.id, err: (e as Error).message }, 'get_status gagal, dicoba lagi siklus berikutnya');
          }
        });
      }
      for (const o of retryable) {
        jobs.push(async () => {
          if (o.status === 'REFUND_FAILED') await this.orders.refund(o.id);
          else await this.orders.cancelOrder(o.id, 'retry');
        });
      }

      const queue = [...jobs];
      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
          for (let j = queue.shift(); j; j = queue.shift()) {
            try { await j(); } catch (e) { logger.error({ err: String(e) }, 'job worker gagal'); }
          }
        }),
      );
    } catch (e) {
      logger.error({ err: String(e) }, 'tick worker gagal');
    } finally {
      this.running = false;
    }
  }
}

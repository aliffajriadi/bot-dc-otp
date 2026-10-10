import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import type { SettingsApi } from './types.js';

export const KEYS = {
  markupGlobal: 'markup_global',
  timeout: 'order_timeout_minutes',
  maintenance: 'maintenance',
  panelChannel: 'panel_channel_id',
  panelMessage: 'panel_message_id',
  logChannel: 'log_channel_id',
  panelTitle: 'panel_title',
  panelText: 'panel_text',
  panelFooter: 'panel_footer',
  panelColor: 'panel_color',
  panelImage: 'panel_image',
} as const;

/** Jenis log yang bisa diarahkan ke channel masing-masing. `semua` = cadangan untuk jenis yang belum diatur. */
export const LOG_TYPES = ['semua', 'buy', 'otp', 'refund', 'gagal', 'alert'] as const;
export type LogType = (typeof LOG_TYPES)[number];
export const logKey = (t: LogType) => (t === 'semua' ? KEYS.logChannel : `log_channel_${t}`);

export const TIMEOUT_MIN = 1;
export const TIMEOUT_MAX = 20;

export class Settings implements SettingsApi {
  constructor(private db: PrismaClient, private cfg: Pick<Config, 'DEFAULT_MARKUP_RP' | 'ORDER_TIMEOUT_MINUTES'>) {}

  async get(key: string): Promise<string | null> {
    return (await this.db.setting.findUnique({ where: { key } }))?.value ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.db.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  async del(key: string): Promise<void> {
    await this.db.setting.deleteMany({ where: { key } });
  }

  private int(v: string | null, def: number): number {
    const n = v === null ? NaN : Number(v);
    return Number.isInteger(n) ? n : def;
  }

  async getMarkupGlobal() {
    return this.int(await this.get(KEYS.markupGlobal), this.cfg.DEFAULT_MARKUP_RP);
  }
  async getMarkupForService(serviceId: string) {
    const o = await this.db.serviceMarkup.findUnique({ where: { serviceId } });
    return o ? o.markup : this.getMarkupGlobal();
  }
  async getMarkups() {
    const [global, rows] = await Promise.all([this.getMarkupGlobal(), this.db.serviceMarkup.findMany()]);
    return { global, overrides: Object.fromEntries(rows.map((r) => [r.serviceId, r.markup])) };
  }
  async setMarkupGlobal(n: number) { await this.set(KEYS.markupGlobal, String(n)); }
  async setMarkupService(serviceId: string, n: number) {
    await this.db.serviceMarkup.upsert({ where: { serviceId }, update: { markup: n }, create: { serviceId, markup: n } });
  }
  async resetMarkupService(serviceId: string) { await this.db.serviceMarkup.deleteMany({ where: { serviceId } }); }

  async getTimeoutMinutes() {
    const n = this.int(await this.get(KEYS.timeout), this.cfg.ORDER_TIMEOUT_MINUTES);
    return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, n));
  }
  async setTimeoutMinutes(n: number) { await this.set(KEYS.timeout, String(n)); }

  async isMaintenance() { return (await this.get(KEYS.maintenance)) === 'on'; }
  async setMaintenance(on: boolean) { await this.set(KEYS.maintenance, on ? 'on' : 'off'); }
}

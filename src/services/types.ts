export type OrderStatus =
  | 'PENDING_PAYMENT' | 'PAID' | 'WAITING_SMS' | 'COMPLETED' | 'CANCEL_PENDING'
  | 'REFUNDED' | 'REFUND_FAILED' | 'FAILED' | 'FAILED_REFUNDED' | 'NEEDS_REVIEW';

export interface OrderRow {
  id: string;
  discordId: string;
  countryId: string;
  countryName: string;
  operatorId: string;
  operatorName: string | null;
  serviceId: string;
  serviceName: string;
  providerPrice: number;
  markup: number;
  paidAmount: number;
  providerOrderId: string | null;
  phoneNumber: string | null;
  smsText: string | null;
  status: OrderStatus;
  expiresAt: Date | null;
  refundedAt: Date | null;
  failReason: string | null;
  dmChannelId: string | null;
  dmMessageId: string | null;
  cancelAttempts: number;
  refundAttempts: number;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewOrder = Pick<OrderRow, 'discordId' | 'countryId' | 'countryName' | 'operatorId' | 'operatorName' | 'serviceId' | 'serviceName' | 'providerPrice' | 'markup' | 'paidAmount'> &
  Partial<Pick<OrderRow, 'dmChannelId' | 'dmMessageId'>>;

export type OrderPatch = Partial<Omit<OrderRow, 'id' | 'createdAt' | 'updatedAt'>>;

export const ACTIVE_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'WAITING_SMS', 'CANCEL_PENDING'];
export const TERMINAL_STATUSES: OrderStatus[] = ['COMPLETED', 'REFUNDED', 'FAILED', 'FAILED_REFUNDED'];
export const REFUNDABLE_STATUSES: OrderStatus[] = ['PAID', 'WAITING_SMS', 'CANCEL_PENDING', 'REFUND_FAILED'];

export interface OrderStore {
  create(data: NewOrder): Promise<OrderRow>;
  get(id: string): Promise<OrderRow | null>;
  /** Update biasa; kalau status berubah dicatat sebagai OrderEvent. */
  update(id: string, patch: OrderPatch, note?: string): Promise<OrderRow>;
  /** Update kondisional atomik: hanya jika status saat ini ada di `from`. null kalau tidak cocok. */
  transition(id: string, from: OrderStatus[], patch: OrderPatch, note?: string): Promise<OrderRow | null>;
  /** Set refundedAt hanya jika masih null. true kalau klaim berhasil. */
  claimRefund(id: string, at: Date): Promise<boolean>;
  releaseRefund(id: string): Promise<void>;
  listByStatus(statuses: OrderStatus[]): Promise<OrderRow[]>;
  countActive(discordId: string): Promise<number>;
  recent(discordId: string, limit: number): Promise<OrderRow[]>;
  /** Order yang refundedAt-nya terisi tetapi status belum final (klaim refund menggantung). */
  listDanglingRefundClaims(): Promise<OrderRow[]>;
}

export interface AdminStore extends OrderStore {
  listRecent(limit: number, status?: OrderStatus): Promise<OrderRow[]>;
  statsSince(since: Date): Promise<{ total: number; completed: number; refunded: number; margin: number; revenue: number }>;
  events(orderId: string, limit: number): Promise<{ fromState: string | null; toState: string; note: string | null; createdAt: Date }[]>;
}

export interface SettingsApi {
  getMarkupGlobal(): Promise<number>;
  /** markup efektif (override kalau ada, kalau tidak global) */
  getMarkupForService(serviceId: string): Promise<number>;
  getMarkups(): Promise<{ global: number; overrides: Record<string, number> }>;
  getTimeoutMinutes(): Promise<number>;
  isMaintenance(): Promise<boolean>;
}

export interface Notifier {
  notifyOwner(text: string): Promise<void>;
}

export interface Messenger {
  /** Kirim pesan awal ke DM (juga sebagai cek DM terbuka). Lempar error kalau DM tertutup. */
  openOrderMessage(discordId: string): Promise<{ channelId: string; messageId: string }>;
  /** Render ulang pesan DM order sesuai status terbaru. Best-effort. */
  refresh(order: OrderRow): Promise<void>;
  /** Kirim OTP sebagai pesan baru supaya user dapat notifikasi. */
  sendOtp(order: OrderRow, code: string | null): Promise<void>;
}

export type ActivityKind = 'PURCHASED' | 'COMPLETED' | 'REFUNDED' | 'FAILED' | 'REVIEW';

/** Log aktivitas pembelian untuk owner (channel log). Best-effort. */
export interface ActivityLog {
  record(kind: ActivityKind, order: OrderRow): Promise<void>;
}

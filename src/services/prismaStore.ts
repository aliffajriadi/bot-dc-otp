import type { Prisma, PrismaClient } from '@prisma/client';
import type { AdminStore, NewOrder, OrderPatch, OrderRow, OrderStatus } from './types.js';
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from './types.js';

export class PrismaOrderStore implements AdminStore {
  constructor(private db: PrismaClient) {}

  private async event(orderId: string, from: string | null, to: string, note?: string) {
    await this.db.orderEvent.create({ data: { orderId, fromState: from, toState: to, note: note ?? null } });
  }

  async create(data: NewOrder) {
    const o = await this.db.order.create({ data: { ...data, status: 'PENDING_PAYMENT' } });
    await this.event(o.id, null, 'PENDING_PAYMENT', 'order dibuat');
    return o as OrderRow;
  }

  async get(id: string) {
    return (await this.db.order.findUnique({ where: { id } })) as OrderRow | null;
  }

  async update(id: string, patch: OrderPatch, note?: string) {
    const before = patch.status ? await this.db.order.findUnique({ where: { id }, select: { status: true } }) : null;
    const o = await this.db.order.update({ where: { id }, data: patch as Prisma.OrderUpdateInput });
    if (patch.status && before?.status !== patch.status) await this.event(id, before?.status ?? null, patch.status, note ?? patch.failReason ?? undefined);
    return o as OrderRow;
  }

  async transition(id: string, from: OrderStatus[], patch: OrderPatch, note?: string) {
    const res = await this.db.order.updateMany({ where: { id, status: { in: from } }, data: patch as Prisma.OrderUpdateManyMutationInput });
    if (res.count !== 1) return null;
    const o = (await this.get(id))!;
    if (patch.status) await this.event(id, from.join('|'), patch.status, note ?? patch.failReason ?? undefined);
    return o;
  }

  async claimRefund(id: string, at: Date) {
    const res = await this.db.order.updateMany({ where: { id, refundedAt: null }, data: { refundedAt: at } });
    return res.count === 1;
  }

  async releaseRefund(id: string) {
    await this.db.order.update({ where: { id }, data: { refundedAt: null } });
  }

  async listByStatus(statuses: OrderStatus[]) {
    return (await this.db.order.findMany({ where: { status: { in: statuses } }, orderBy: { createdAt: 'asc' } })) as OrderRow[];
  }

  countActive(discordId: string) {
    return this.db.order.count({ where: { discordId, status: { in: ACTIVE_STATUSES } } });
  }

  async recent(discordId: string, limit: number) {
    return (await this.db.order.findMany({ where: { discordId }, orderBy: { createdAt: 'desc' }, take: limit })) as OrderRow[];
  }

  async listDanglingRefundClaims() {
    return (await this.db.order.findMany({ where: { refundedAt: { not: null }, status: { notIn: [...TERMINAL_STATUSES, 'NEEDS_REVIEW'] } } })) as OrderRow[];
  }

  async listRecent(limit: number, status?: OrderStatus) {
    return (await this.db.order.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: limit })) as OrderRow[];
  }

  async statsSince(since: Date) {
    const rows = await this.db.order.findMany({ where: { createdAt: { gte: since } }, select: { status: true, markup: true, paidAmount: true } });
    const done = rows.filter((r) => r.status === 'COMPLETED');
    return {
      total: rows.length,
      completed: done.length,
      refunded: rows.filter((r) => r.status === 'REFUNDED' || r.status === 'FAILED_REFUNDED').length,
      margin: done.reduce((a, r) => a + r.markup, 0),
      revenue: done.reduce((a, r) => a + r.paidAmount, 0),
    };
  }

  async events(orderId: string, limit: number) {
    return this.db.orderEvent.findMany({ where: { orderId }, orderBy: { id: 'desc' }, take: limit });
  }
}

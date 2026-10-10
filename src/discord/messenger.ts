import type { Client, TextBasedChannel } from 'discord.js';
import { logger } from '../logger.js';
import type { Settings } from '../services/settings.js';
import { logKey, type LogType } from '../services/settings.js';
import type { ActivityKind, ActivityLog, Messenger, Notifier, OrderRow, OrderStore } from '../services/types.js';
import { EmbedBuilder } from 'discord.js';
import { rupiah } from '../util/format.js';
import { flagFor } from '../util/flags.js';
import { orderMessage } from './ui.js';

export class DiscordMessenger implements Messenger {
  constructor(private client: Client, private settings: Settings, private cancelMin: number) {}

  async openOrderMessage(discordId: string) {
    const user = await this.client.users.fetch(discordId);
    const msg = await user.send('⏳ Memproses pesananmu...');
    return { channelId: msg.channelId, messageId: msg.id };
  }

  async refresh(o: OrderRow) {
    if (!o.dmChannelId || !o.dmMessageId) return;
    try {
      const ch = (await this.client.channels.fetch(o.dmChannelId)) as TextBasedChannel | null;
      if (!ch || !('messages' in ch)) return;
      const msg = await ch.messages.fetch(o.dmMessageId);
      await msg.edit(orderMessage(o, await this.settings.getTimeoutMinutes(), this.cancelMin));
    } catch (e) {
      logger.warn({ orderId: o.id, err: (e as Error).message }, 'gagal edit pesan DM');
    }
  }

  async sendOtp(o: OrderRow, code: string | null) {
    const user = await this.client.users.fetch(o.discordId);
    const lines = [code ? `✅ Kode OTP kamu: **\`${code}\`**` : '✅ SMS sudah masuk.', '', `SMS: ${o.smsText ?? '-'}`, `Order #${o.id}`];
    await user.send(lines.join('\n'));
  }
}

/** Channel per jenis log; kalau belum diatur pakai `semua`, lalu LOG_CHANNEL_ID dari env. */
async function resolveLogChannel(settings: Settings, type: LogType, envId?: string): Promise<string | undefined> {
  return (await settings.get(logKey(type))) || (await settings.get(logKey('semua'))) || envId || undefined;
}

const KIND_TYPE: Record<ActivityKind, LogType> = { PURCHASED: 'buy', COMPLETED: 'otp', REFUNDED: 'refund', FAILED: 'gagal', REVIEW: 'gagal' };

const maskPhone = (p: string | null) => (p ? `${p.slice(0, 4)}••••${p.slice(-3)}` : '-');

const ACTIVITY: Record<ActivityKind, { title: string; color: number }> = {
  PURCHASED: { title: '🛒 Pembelian baru', color: 0x5865f2 },
  COMPLETED: { title: '✅ OTP diterima', color: 0x57f287 },
  REFUNDED: { title: '↩️ Refund', color: 0x95a5a6 },
  FAILED: { title: '❌ Order gagal', color: 0xe74c3c },
  REVIEW: { title: '🛠️ Perlu dicek', color: 0xe67e22 },
};

export class DiscordActivityLog implements ActivityLog {
  constructor(private client: Client, private settings: Settings, private envChannelId?: string) {}

  async record(kind: ActivityKind, o: OrderRow) {
    const chId = await resolveLogChannel(this.settings, KIND_TYPE[kind], this.envChannelId);
    if (!chId) return;
    const { title, color } = ACTIVITY[kind];
    const e = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp(new Date()).setFooter({ text: `Order #${o.id}` }).addFields(
      { name: 'User', value: `<@${o.discordId}>`, inline: true },
      { name: 'Service', value: o.serviceName, inline: true },
      { name: 'Negara', value: `${flagFor(o.countryName)} ${o.countryName}`, inline: true },
      { name: 'Harga', value: `${rupiah(o.paidAmount)} (margin ${rupiah(o.markup)})`, inline: true },
      { name: 'Nomor', value: maskPhone(o.phoneNumber), inline: true },
      { name: 'Status', value: o.status, inline: true },
    );
    const ch = await this.client.channels.fetch(chId);
    if (ch?.isTextBased() && 'send' in ch) await ch.send({ embeds: [e] });
  }
}

export class DiscordNotifier implements Notifier {
  constructor(private client: Client, private ownerIds: string[], private settings: Settings, private envChannelId?: string) {}

  async notifyOwner(text: string) {
    logger.warn({ text }, 'notifikasi owner');
    let delivered = false;
    const logChannelId = await resolveLogChannel(this.settings, 'alert', this.envChannelId).catch(() => undefined);
    if (logChannelId) {
      try {
        const ch = await this.client.channels.fetch(logChannelId);
        if (ch?.isTextBased() && 'send' in ch) { await ch.send(text.slice(0, 1900)); delivered = true; }
      } catch (e) {
        logger.error({ err: (e as Error).message }, 'gagal kirim ke channel log');
      }
    }
    if (delivered) return;
    for (const id of this.ownerIds) {
      try {
        await (await this.client.users.fetch(id)).send(text.slice(0, 1900));
      } catch (e) {
        logger.error({ ownerId: id, err: (e as Error).message }, 'gagal DM owner');
      }
    }
  }
}

export type { OrderStore };

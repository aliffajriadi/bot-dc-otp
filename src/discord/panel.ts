import { ButtonInteraction, DiscordAPIError, Message, MessageFlags, type Client, type TextBasedChannel } from 'discord.js';
import { logger } from '../logger.js';
import { KEYS } from '../services/settings.js';
import { rupiah } from '../util/format.js';
import { type App, isOwner } from './app.js';
import { historyLine, panelEmbed, panelRow, type PanelCustom } from './ui.js';

export async function getPanelCustom(app: App): Promise<PanelCustom> {
  const [title, text, footer, color, image] = await Promise.all([
    app.settings.get(KEYS.panelTitle), app.settings.get(KEYS.panelText), app.settings.get(KEYS.panelFooter),
    app.settings.get(KEYS.panelColor), app.settings.get(KEYS.panelImage),
  ]);
  return { title, text, footer, color, image };
}

async function panelPayload(app: App) {
  const [custom, timeout] = await Promise.all([getPanelCustom(app), app.settings.getTimeoutMinutes()]);
  return { embeds: [panelEmbed(custom, timeout)], components: [panelRow()] };
}

const isUnknownMessage = (e: unknown) => e instanceof DiscordAPIError && (e.code === 10008 || e.code === 10003);

/** Hapus panel lama (kalau ada) tanpa crash bila sudah hilang. */
async function removeOldPanel(app: App) {
  const [chId, msgId] = await Promise.all([app.settings.get(KEYS.panelChannel), app.settings.get(KEYS.panelMessage)]);
  if (!chId || !msgId) return;
  try {
    const ch = (await app.client.channels.fetch(chId)) as TextBasedChannel | null;
    if (ch && 'messages' in ch) await (await ch.messages.fetch(msgId)).delete();
  } catch (e) {
    if (!isUnknownMessage(e)) logger.warn({ err: (e as Error).message }, 'gagal hapus panel lama');
  }
}

/** `!show panel` (khusus owner). */
export async function handlePanelCommand(app: App, msg: Message) {
  if (msg.author.bot || !msg.guild) return;
  const cmd = `${app.cfg.PANEL_PREFIX}show panel`;
  if (msg.content.trim().toLowerCase() !== cmd.toLowerCase()) return;
  if (!isOwner(app, msg.author.id)) return; // diam-diam

  const channel = msg.channel;
  await msg.delete().catch(() => logger.warn('tidak bisa menghapus pesan !show panel (izin kurang?)'));
  try {
    await removeOldPanel(app);
    if (!('send' in channel)) return;
    const sent = await channel.send(await panelPayload(app));
    await app.settings.set(KEYS.panelChannel, sent.channelId);
    await app.settings.set(KEYS.panelMessage, sent.id);
    logger.info({ channelId: sent.channelId, messageId: sent.id }, 'panel dibuat');
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'gagal membuat panel');
    await app.notifier.notifyOwner(`⚠️ Gagal membuat panel di <#${channel.id}>: ${(e as Error).message}. Pastikan bot punya izin View Channel, Send Messages, Embed Links, dan Manage Messages.`);
  }
}

/** Dipakai /admin panel-text untuk memperbarui panel yang sudah ada. */
export async function refreshPanel(app: App): Promise<boolean> {
  const [chId, msgId] = await Promise.all([app.settings.get(KEYS.panelChannel), app.settings.get(KEYS.panelMessage)]);
  if (!chId || !msgId) return false;
  try {
    const ch = (await app.client.channels.fetch(chId)) as TextBasedChannel | null;
    if (!ch || !('messages' in ch)) return false;
    await (await ch.messages.fetch(msgId)).edit(await panelPayload(app));
    return true;
  } catch (e) {
    if (isUnknownMessage(e)) return false;
    logger.error({ err: (e as Error).message }, 'gagal refresh panel');
    await app.notifier.notifyOwner(`⚠️ Gagal memperbarui panel: ${(e as Error).message}`);
    return false;
  }
}

export async function handleBalance(app: App, i: ButtonInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const u = await app.saldo.checkUser(i.user.id);
    if (!u) return void (await i.editReply('Akunmu belum terdaftar di sistem saldo.'));
    await i.editReply(`💰 Saldomu: **${rupiah(u.balanceRupiah)}**`);
  } catch {
    await i.editReply('Saldo belum bisa dicek sekarang. Coba lagi sebentar lagi.');
  }
}

export async function handleHistory(app: App, i: ButtonInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const rows = await app.store.recent(i.user.id, 10);
  if (!rows.length) return void (await i.editReply('Kamu belum punya riwayat order.'));
  await i.editReply(`📜 **10 order terakhir**\n${rows.map(historyLine).join('\n')}`);
}

export type { Client };

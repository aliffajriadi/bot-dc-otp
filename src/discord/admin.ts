import { ActionRowBuilder, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, ModalSubmitInteraction, SlashCommandBuilder, TextInputBuilder, TextInputStyle, type ChatInputCommandInteraction } from 'discord.js';
import { KEYS, LOG_TYPES, logKey, TIMEOUT_MAX, TIMEOUT_MIN, type LogType } from '../services/settings.js';
import type { OrderStatus } from '../services/types.js';
import { rupiah } from '../util/format.js';
import { type App, isOwner } from './app.js';
import { getPanelCustom, refreshPanel } from './panel.js';
import { DEFAULT_PANEL_TEXT, DEFAULT_PANEL_TITLE, parseColor } from './ui.js';
import { STATUS_LABEL } from './ui.js';

const STATUSES = Object.keys(STATUS_LABEL) as OrderStatus[];

export const adminCommand = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Perintah owner')
  .setDefaultMemberPermissions(0)
  .addSubcommand((s) => s.setName('markup-global').setDescription('Ubah markup global').addIntegerOption((o) => o.setName('nominal').setDescription('Rupiah').setMinValue(0).setRequired(true)))
  .addSubcommand((s) => s.setName('markup-service').setDescription('Override markup satu service')
    .addStringOption((o) => o.setName('service_id').setDescription('ID service').setRequired(true))
    .addStringOption((o) => o.setName('nominal').setDescription('Rupiah, kosong atau "reset" untuk hapus override')))
  .addSubcommand((s) => s.setName('markup-list').setDescription('Lihat markup global dan override'))
  .addSubcommand((s) => s.setName('timeout').setDescription('Ubah batas tunggu SMS').addIntegerOption((o) => o.setName('menit').setDescription(`${TIMEOUT_MIN}-${TIMEOUT_MAX}`).setMinValue(TIMEOUT_MIN).setMaxValue(TIMEOUT_MAX).setRequired(true)))
  .addSubcommand((s) => s.setName('order').setDescription('Detail satu order').addStringOption((o) => o.setName('order_id').setDescription('ID order').setRequired(true)))
  .addSubcommand((s) => s.setName('refund').setDescription('Refund manual order NEEDS_REVIEW (pastikan saldo user memang terpotong)').addStringOption((o) => o.setName('order_id').setDescription('ID order').setRequired(true)))
  .addSubcommand((s) => s.setName('orders').setDescription('Daftar order terbaru').addStringOption((o) => o.setName('status').setDescription('Filter status').addChoices(...STATUSES.map((x) => ({ name: x, value: x })))))
  .addSubcommand((s) => s.setName('stats').setDescription('Ringkasan hari ini'))
  .addSubcommand((s) => s.setName('maintenance').setDescription('Tutup/buka pembelian baru').addStringOption((o) => o.setName('mode').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
  .addSubcommand((s) => s.setName('logs').setDescription('Atur channel log per jenis (kosongkan channel untuk mematikan)')
    .addStringOption((o) => o.setName('jenis').setDescription('Jenis log').setRequired(true).addChoices(
      { name: 'buy: pembelian baru', value: 'buy' },
      { name: 'otp: OTP diterima', value: 'otp' },
      { name: 'refund: refund', value: 'refund' },
      { name: 'gagal: order gagal / perlu dicek', value: 'gagal' },
      { name: 'alert: notifikasi owner (NO BALANCE dll)', value: 'alert' },
      { name: 'semua: cadangan untuk jenis yang belum diatur', value: 'semua' }))
    .addChannelOption((o) => o.setName('channel').setDescription('Channel teks untuk log').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) => s.setName('logs-list').setDescription('Lihat pengaturan channel log'))
  .addSubcommand((s) => s.setName('panel-text').setDescription('Edit tampilan panel (judul, isi, footer, warna, gambar) lewat form')
    .addBooleanOption((o) => o.setName('reset').setDescription('true = kembalikan semua tampilan panel ke bawaan')));

export const PANEL_MODAL_ID = 'admin:panel';

async function showPanelModal(app: App, i: ChatInputCommandInteraction) {
  const c = await getPanelCustom(app);
  const input = (id: string, label: string, style: TextInputStyle, value: string | null, max: number, ph?: string) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(false).setMaxLength(max);
    if (value) t.setValue(value.slice(0, max));
    if (ph) t.setPlaceholder(ph);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };
  const modal = new ModalBuilder().setCustomId(PANEL_MODAL_ID).setTitle('Edit panel').addComponents(
    input('title', 'Judul', TextInputStyle.Short, c.title, 200, DEFAULT_PANEL_TITLE),
    input('text', 'Isi (boleh pakai {timeout}; kosong = bawaan)', TextInputStyle.Paragraph, c.text ?? DEFAULT_PANEL_TEXT, 3000),
    input('footer', 'Footer', TextInputStyle.Short, c.footer, 200),
    input('color', 'Warna hex (contoh #5865F2)', TextInputStyle.Short, c.color, 7, '#5865F2'),
    input('image', 'URL gambar banner (https://...)', TextInputStyle.Short, c.image, 500),
  );
  await i.showModal(modal);
}

export async function handlePanelModal(app: App, i: ModalSubmitInteraction) {
  if (!isOwner(app, i.user.id)) return void (await i.reply({ content: 'Khusus owner.', flags: MessageFlags.Ephemeral }));
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const v = (k: string) => i.fields.getTextInputValue(k).trim();
  const color = v('color');
  const image = v('image');
  if (color && !parseColor(color)) return void (await i.editReply('Warna harus hex 6 digit, contoh `#5865F2`. Tidak ada yang disimpan.'));
  if (image && !/^https:\/\/\S+$/i.test(image)) return void (await i.editReply('URL gambar harus diawali `https://`. Tidak ada yang disimpan.'));
  const text = v('text');
  const pairs: [string, string][] = [
    [KEYS.panelTitle, v('title')], [KEYS.panelText, text === DEFAULT_PANEL_TEXT ? '' : text], [KEYS.panelFooter, v('footer')],
    [KEYS.panelColor, color], [KEYS.panelImage, image],
  ];
  for (const [k, val] of pairs) val ? await app.settings.set(k, val) : await app.settings.del(k);
  const ok = await refreshPanel(app);
  await i.editReply(ok ? 'Tampilan panel diperbarui.' : 'Tersimpan. Panel belum ada atau hilang: jalankan `!show panel` lagi.');
}

export async function handleAdmin(app: App, i: ChatInputCommandInteraction) {
  if (!isOwner(app, i.user.id)) {
    return void (await i.reply({ content: 'Perintah ini khusus owner.', flags: MessageFlags.Ephemeral }));
  }
  const sub = i.options.getSubcommand();
  if (sub === 'panel-text' && !i.options.getBoolean('reset')) return showPanelModal(app, i);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const { settings, store } = app;

  switch (sub) {
    case 'markup-global': {
      const n = i.options.getInteger('nominal', true);
      await settings.setMarkupGlobal(n);
      return void (await i.editReply(`Markup global sekarang **${rupiah(n)}**. Berlaku langsung di harga yang tampil.`));
    }
    case 'markup-service': {
      const sid = i.options.getString('service_id', true).trim();
      const raw = (i.options.getString('nominal') ?? '').trim().toLowerCase();
      if (raw === '' || raw === 'reset') {
        await settings.resetMarkupService(sid);
        return void (await i.editReply(`Override markup service \`${sid}\` dihapus (ikut markup global).`));
      }
      const n = Number(raw.replace(/[^\d]/g, ''));
      if (!/^\d+$/.test(raw.replace(/[.\s]/g, '')) || !Number.isInteger(n)) return void (await i.editReply('Nominal harus angka bulat, atau `reset`.'));
      await settings.setMarkupService(sid, n);
      return void (await i.editReply(`Markup service \`${sid}\` sekarang **${rupiah(n)}**.`));
    }
    case 'markup-list': {
      const { global, overrides } = await settings.getMarkups();
      const lines = Object.entries(overrides).map(([k, v]) => `• \`${k}\`: ${rupiah(v)}`);
      return void (await i.editReply(`**Markup global:** ${rupiah(global)}\n**Override:**\n${lines.join('\n') || '_tidak ada_'}`.slice(0, 1900)));
    }
    case 'timeout': {
      const m = i.options.getInteger('menit', true);
      await settings.setTimeoutMinutes(m);
      await refreshPanel(app);
      return void (await i.editReply(`Batas tunggu SMS sekarang **${m} menit** (berlaku untuk order baru).`));
    }
    case 'order': {
      const o = await store.get(i.options.getString('order_id', true).trim());
      if (!o) return void (await i.editReply('Order tidak ditemukan.'));
      const ev = await store.events(o.id, 8);
      const t = (d: Date | null) => (d ? `<t:${Math.floor(d.getTime() / 1000)}:f>` : '-');
      const e = new EmbedBuilder().setTitle(`Order ${o.id}`).setColor(0x5865f2).addFields(
        { name: 'User', value: `<@${o.discordId}> (${o.discordId})` },
        { name: 'Service', value: `${o.serviceName} (${o.serviceId})\n${o.countryName} / ${o.operatorName ?? o.operatorId}`, inline: true },
        { name: 'Harga', value: `Provider ${rupiah(o.providerPrice)} + markup ${rupiah(o.markup)} = **${rupiah(o.paidAmount)}**`, inline: true },
        { name: 'Status', value: o.status, inline: true },
        { name: 'Nomor / provider order', value: `${o.phoneNumber ?? '-'} / ${o.providerOrderId ?? '-'}` },
        { name: 'Waktu', value: `Dibuat ${t(o.createdAt)}\nKedaluwarsa ${t(o.expiresAt)}\nRefund ${t(o.refundedAt)}` },
        { name: 'Catatan', value: `${o.failReason ?? '-'}\ncancel x${o.cancelAttempts}, refund x${o.refundAttempts}` },
        { name: 'SMS', value: o.smsText?.slice(0, 500) || '-' },
        { name: 'Riwayat status', value: ev.map((x) => `${x.fromState ?? '∅'} → ${x.toState}${x.note ? ` (${x.note.slice(0, 60)})` : ''}`).join('\n').slice(0, 1000) || '-' },
      );
      return void (await i.editReply({ embeds: [e] }));
    }
    case 'refund': {
      const r = await app.orders.adminRefund(i.options.getString('order_id', true).trim());
      return void (await i.editReply(`${r.ok ? '✅' : '⚠️'} ${r.message}`));
    }
    case 'orders': {
      const st = (i.options.getString('status') ?? undefined) as OrderStatus | undefined;
      const rows = await store.listRecent(15, st);
      if (!rows.length) return void (await i.editReply('Tidak ada order.'));
      return void (await i.editReply(rows.map((o) => `\`${o.id}\` <@${o.discordId}> ${o.serviceName} ${rupiah(o.paidAmount)} **${o.status}**`).join('\n').slice(0, 1990)));
    }
    case 'stats': {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const s = await store.statsSince(start);
      return void (await i.editReply(`📊 **Hari ini**\nOrder: ${s.total}\nSukses: ${s.completed}\nRefund: ${s.refunded}\nOmzet (sukses): ${rupiah(s.revenue)}\nEstimasi margin: **${rupiah(s.margin)}**`));
    }
    case 'maintenance': {
      const on = i.options.getString('mode', true) === 'on';
      await settings.setMaintenance(on);
      return void (await i.editReply(on ? '🔒 Maintenance **ON**: pembelian baru ditutup, order aktif tetap diproses.' : '🔓 Maintenance **OFF**: pembelian dibuka.'));
    }
    case 'logs': {
      const type = i.options.getString('jenis', true) as LogType;
      const ch = i.options.getChannel('channel');
      if (!ch) {
        await settings.del(logKey(type));
        return void (await i.editReply(`Log **${type}** dimatikan (memakai cadangan \`semua\`/env bila ada).`));
      }
      try {
        const target = await app.client.channels.fetch(ch.id);
        if (!target?.isTextBased() || !('send' in target)) throw new Error('bukan channel teks');
        await target.send(`✅ Channel ini dipakai untuk log **${type}**.`);
      } catch (e) {
        return void (await i.editReply(`⚠️ Bot tidak bisa mengirim ke <#${ch.id}> (${(e as Error).message}). Beri izin View Channel, Send Messages, Embed Links lalu coba lagi.`));
      }
      await settings.set(logKey(type), ch.id);
      return void (await i.editReply(`Log **${type}** sekarang dikirim ke <#${ch.id}>.`));
    }
    case 'logs-list': {
      const lines = await Promise.all(LOG_TYPES.map(async (t) => {
        const id = await settings.get(logKey(t));
        return `• **${t}**: ${id ? `<#${id}>` : '_belum diatur_'}`;
      }));
      return void (await i.editReply(`${lines.join('\n')}\n\nJenis yang belum diatur memakai \`semua\`, lalu \`LOG_CHANNEL_ID\` di .env. Notifikasi \`alert\` tanpa channel dikirim lewat DM owner.`));
    }
    case 'panel-text': {
      for (const k of [KEYS.panelTitle, KEYS.panelText, KEYS.panelFooter, KEYS.panelColor, KEYS.panelImage]) await settings.del(k);
      const ok = await refreshPanel(app);
      return void (await i.editReply(ok ? 'Tampilan panel dikembalikan ke bawaan.' : 'Dikembalikan ke bawaan. Panel belum ada: jalankan `!show panel`.'));
    }
  }
}

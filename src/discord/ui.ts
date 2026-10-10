import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { flagFor } from '../util/flags.js';
import { rupiah } from '../util/format.js';
import type { OrderRow, OrderStatus } from '../services/types.js';

export const IDS = {
  panelBuy: 'panel:buy',
  panelBalance: 'panel:balance',
  panelHistory: 'panel:history',
  dmCancel: 'dm:cancel:',
  dmResendLegacy: 'dm:resend:',
} as const;

export const DEFAULT_PANEL_TITLE = '🛒 Toko OTP';
export const DEFAULT_PANEL_TEXT =
  'Beli nomor untuk verifikasi SMS (OTP) langsung dari Discord.\n\n**Cara beli**\n1. Klik **Beli OTP**\n2. Pilih negara, operator, dan service\n3. Konfirmasi, nomor dikirim ke DM kamu\n4. Pakai nomor itu, kode OTP muncul otomatis di DM';

export interface PanelCustom {
  title: string | null;
  text: string | null;
  footer: string | null;
  color: string | null;
  image: string | null;
}

export const parseColor = (v: string | null): number | null => (v && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? parseInt(v.trim().replace('#', ''), 16) : null);

export function panelEmbed(c: PanelCustom, timeoutMin: number) {
  const e = new EmbedBuilder()
    .setTitle(c.title || DEFAULT_PANEL_TITLE)
    .setDescription((c.text || DEFAULT_PANEL_TEXT).replaceAll('{timeout}', String(timeoutMin)))
    .addFields(
      { name: '⏱️ Waktu tunggu', value: `Maksimal ${timeoutMin} menit per nomor.`, inline: true },
      { name: '💸 Kebijakan refund', value: 'Kalau SMS tidak masuk, order dibatalkan dan saldo dikembalikan otomatis.', inline: true },
    )
    .setColor(parseColor(c.color) ?? 0x5865f2);
  if (c.footer) e.setFooter({ text: c.footer.slice(0, 2000) });
  if (c.image && /^https:\/\//i.test(c.image)) e.setImage(c.image);
  return e;
}

export function panelRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(IDS.panelBuy).setLabel('Beli OTP').setEmoji('🛒').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.panelBalance).setLabel('Cek Saldo').setEmoji('💰').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.panelHistory).setLabel('Riwayat').setEmoji('📜').setStyle(ButtonStyle.Secondary),
  );
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: '⏳ Memproses pembayaran',
  PAID: '⏳ Memesan nomor',
  WAITING_SMS: '📨 Menunggu SMS',
  COMPLETED: '✅ Selesai',
  CANCEL_PENDING: '⏳ Membatalkan',
  REFUNDED: '↩️ Dibatalkan, saldo dikembalikan',
  REFUND_FAILED: '⏳ Mengembalikan saldo',
  FAILED: '❌ Gagal',
  FAILED_REFUNDED: '↩️ Gagal, saldo dikembalikan',
  NEEDS_REVIEW: '🛠️ Dicek admin',
};

const ts = (d: Date, f: 'R' | 'f' = 'R') => `<t:${Math.floor(d.getTime() / 1000)}:${f}>`;

/** Pesan DM untuk satu order, mengikuti status terbaru. */
export function cancelUnlockAt(o: OrderRow, cancelMin: number): Date {
  return new Date(o.createdAt.getTime() + cancelMin * 60_000);
}

export function orderMessage(o: OrderRow, timeoutMin = 5, cancelMin = 5, now = new Date()) {
  const e = new EmbedBuilder().setTitle(`${STATUS_LABEL[o.status]}`).setFooter({ text: `Order #${o.id}` });
  e.addFields({ name: 'Service', value: o.serviceName, inline: true }, { name: 'Harga', value: rupiah(o.paidAmount), inline: true });
  const bigNumber = o.phoneNumber ? `# ${flagFor(o.countryName)} \`${o.phoneNumber}\`\n` : '';

  const row = new ActionRowBuilder<ButtonBuilder>();
  switch (o.status) {
    case 'WAITING_SMS':
      e.setColor(0xfee75c).setDescription(
        `${bigNumber}Nomor kamu sudah siap. Tunggu SMS-nya sampai ${o.expiresAt ? ts(o.expiresAt) : `${timeoutMin} menit`}, kalau tidak masuk saldo otomatis dikembalikan.\n\nTekan dan tahan nomor di atas untuk menyalinnya.`,
      );
      {
        const unlock = cancelUnlockAt(o, cancelMin);
        const locked = now < unlock;
        row.addComponents(new ButtonBuilder().setCustomId(IDS.dmCancel + o.id).setLabel(locked ? `Batalkan (setelah ${cancelMin} menit)` : 'Batalkan').setStyle(ButtonStyle.Danger).setDisabled(locked));
        if (locked) e.addFields({ name: 'Pembatalan', value: `Baru bisa dilakukan ${ts(unlock)}.` });
      }
      break;
    case 'COMPLETED':
      e.setColor(0x57f287).setDescription(`${bigNumber}SMS sudah masuk. Kode ada di pesan berikutnya.`);
      if (o.smsText) e.addFields({ name: 'SMS', value: o.smsText.slice(0, 1000) });
      break;
    case 'REFUNDED':
    case 'FAILED_REFUNDED':
      e.setColor(0x95a5a6).setDescription(`Saldo ${rupiah(o.paidAmount)} sudah dikembalikan.`);
      break;
    case 'CANCEL_PENDING':
    case 'REFUND_FAILED':
      e.setColor(0xe67e22).setDescription('Sedang diproses. Saldo akan dikembalikan otomatis, tidak perlu melakukan apa pun.');
      break;
    case 'NEEDS_REVIEW':
      e.setColor(0xe74c3c).setDescription('Order ini sedang dicek admin. Saldomu aman, kamu akan dikabari.');
      break;
    case 'FAILED':
      e.setColor(0xe74c3c).setDescription('Order gagal. Tidak ada saldo yang terpotong.');
      break;
    default:
      e.setColor(0x95a5a6).setDescription('Memproses pesananmu...');
  }
  return { embeds: [e], components: row.components.length ? [row] : [], content: '' };
}

export function historyLine(o: OrderRow): string {
  return `\`#${o.id.slice(-6)}\` ${o.serviceName} • ${rupiah(o.paidAmount)} • ${STATUS_LABEL[o.status]} • ${ts(o.createdAt, 'f')}`;
}

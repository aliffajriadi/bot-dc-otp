import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import { logger } from '../logger.js';
import { flagFor } from '../util/flags.js';
import { rupiah } from '../util/format.js';
import type { App } from './app.js';

const PAGE = 25;
const Q_MAX = 20;

type Payload = { content?: string; embeds?: EmbedBuilder[]; components: ActionRowBuilder<any>[] };

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clean = (s: string) => s.replace(/:/g, ' ').trim().slice(0, Q_MAX);
const pages = (n: number) => Math.max(1, Math.ceil(n / PAGE));
const clamp = (p: number, n: number) => Math.min(Math.max(0, p), pages(n) - 1);
const btn = (id: string, label: string, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

/** customId maksimal 100 karakter. */
function id(...parts: (string | number)[]): string {
  const s = parts.join(':');
  if (s.length > 100) throw new Error('customId terlalu panjang');
  return s;
}

// ---------- layar ----------

async function countryScreen(app: App, page: number): Promise<Payload> {
  const list = await app.catalog.countries();
  if (!list.length) return { content: 'Belum ada negara tersedia saat ini.', components: [] };
  page = clamp(page, list.length);
  const slice = list.slice(page * PAGE, (page + 1) * PAGE);
  const rows: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('otp:c').setPlaceholder('Pilih negara').addOptions(slice.map((c) => ({ label: cut(c.name, 100), value: c.id, emoji: flagFor(c.name) }))),
    ),
  ];
  if (list.length > PAGE) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(id('otp:cp', page - 1), '◀ Sebelumnya', ButtonStyle.Secondary, page === 0),
      btn('otp:noop', `${page + 1}/${pages(list.length)}`, ButtonStyle.Secondary, true),
      btn(id('otp:cp', page + 1), 'Berikutnya ▶', ButtonStyle.Secondary, page >= pages(list.length) - 1),
    ));
  }
  return { content: '**Langkah 1/3** — Pilih negara:', embeds: [], components: rows };
}

async function operatorScreen(app: App, countryId: string, page: number): Promise<Payload> {
  const list = await app.catalog.operators(countryId);
  const back = btn('otp:bk:c', '↩ Kembali');
  if (!list.length) return { content: 'Belum ada operator untuk negara ini.', embeds: [], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)] };
  page = clamp(page, list.length);
  const slice = list.slice(page * PAGE, (page + 1) * PAGE);
  const nav = new ActionRowBuilder<ButtonBuilder>();
  if (list.length > PAGE) {
    nav.addComponents(
      btn(id('otp:op', countryId, page - 1), '◀ Sebelumnya', ButtonStyle.Secondary, page === 0),
      btn(id('otp:op', countryId, page + 1), 'Berikutnya ▶', ButtonStyle.Secondary, page >= pages(list.length) - 1),
    );
  }
  nav.addComponents(back);
  return {
    content: '**Langkah 2/3** — Pilih operator:',
    embeds: [],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(id('otp:o', countryId)).setPlaceholder('Pilih operator').addOptions(slice.map((o) => ({ label: cut(o.name, 100), value: o.id }))),
      ),
      nav,
    ],
  };
}

async function serviceScreen(app: App, countryId: string, operatorId: string, page: number, q = ''): Promise<Payload> {
  const all = await app.catalog.services(countryId);
  const query = q.toLowerCase();
  const list = query ? all.filter((s) => s.name.toLowerCase().includes(query)) : all;
  const nav = new ActionRowBuilder<ButtonBuilder>();
  page = clamp(page, list.length);
  if (list.length > PAGE) {
    nav.addComponents(
      btn(id('otp:sp', countryId, operatorId, page - 1, q), '◀', ButtonStyle.Secondary, page === 0),
      btn(id('otp:sp', countryId, operatorId, page + 1, q), '▶', ButtonStyle.Secondary, page >= pages(list.length) - 1),
    );
  }
  nav.addComponents(btn(id('otp:sq', countryId, operatorId), '🔍 Cari'));
  if (q) nav.addComponents(btn(id('otp:sp', countryId, operatorId, 0), '✖ Reset'));
  nav.addComponents(btn(id('otp:bk:o', countryId), '↩ Kembali'));
  const header = `**Langkah 3/3** — Pilih service${q ? ` (filter: "${q}")` : ''}${list.length > PAGE ? ` — hal. ${page + 1}/${pages(list.length)}` : ''}:`;
  if (!list.length) {
    return { content: q ? `Tidak ada service yang cocok dengan "${q}".` : 'Belum ada service untuk negara ini.', embeds: [], components: [nav] };
  }
  const slice = list.slice(page * PAGE, (page + 1) * PAGE);
  return {
    content: header,
    embeds: [],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(id('otp:s', countryId, operatorId)).setPlaceholder('Pilih service')
          .addOptions(slice.map((s) => ({ label: cut(`${s.name} — ${rupiah(s.finalPrice)}`, 100), value: s.id }))),
      ),
      nav,
    ],
  };
}

async function confirmScreen(app: App, userId: string, countryId: string, operatorId: string, serviceId: string, notice?: string): Promise<Payload> {
  const [countries, operators, services, user] = await Promise.all([
    app.catalog.countries(), app.catalog.operators(countryId), app.catalog.services(countryId, true), app.saldo.checkUser(userId).catch(() => null),
  ]);
  const country = countries.find((c) => c.id === countryId);
  const operator = operators.find((o) => o.id === operatorId);
  const svc = services.find((s) => s.id === serviceId);
  const back = btn(id('otp:bk:s', countryId, operatorId), '↩ Kembali');
  if (!country || !operator || !svc) {
    return { content: 'Service ini sudah tidak tersedia. Pilih yang lain ya.', embeds: [], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)] };
  }
  const e = new EmbedBuilder().setTitle('Konfirmasi pembelian').setColor(0x5865f2).addFields(
    { name: 'Negara', value: `${flagFor(country.name)} ${country.name}`, inline: true },
    { name: 'Operator', value: operator.name, inline: true },
    { name: 'Service', value: svc.name, inline: true },
    { name: 'Harga', value: `**${rupiah(svc.finalPrice)}**`, inline: true },
    { name: 'Saldomu', value: user ? rupiah(user.balanceRupiah) : '—', inline: true },
  );
  return {
    content: notice ?? '',
    embeds: [e],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(id('otp:y', countryId, operatorId, serviceId, svc.finalPrice), 'Konfirmasi', ButtonStyle.Success),
      btn('otp:n', 'Batal', ButtonStyle.Danger),
      back,
    )],
  };
}

// ---------- entry point ----------

export async function startBuy(app: App, i: ButtonInteraction) {
  if (await app.settings.isMaintenance()) {
    return void (await i.reply({ content: 'Pembelian sedang ditutup sementara.', flags: MessageFlags.Ephemeral }));
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await i.editReply(await countryScreen(app, 0));
  } catch (e) {
    logger.error({ err: String(e) }, 'startBuy gagal');
    await i.editReply({ content: 'Daftar negara belum bisa dimuat. Coba lagi sebentar lagi.', components: [] });
  }
}

type Comp = ButtonInteraction | StringSelectMenuInteraction;

async function safeUpdate(i: Comp | ModalSubmitInteraction, build: () => Promise<Payload>) {
  try {
    const p = await build();
    if (i.isModalSubmit()) {
      if (i.isFromMessage()) await i.update(p as any);
    } else await i.update(p as any);
  } catch (e) {
    logger.error({ err: String(e) }, 'update layar gagal');
    const msg = { content: 'Terjadi gangguan saat memuat data dari provider. Klik **Beli OTP** lagi di panel ya.', embeds: [], components: [] };
    try {
      if (i.replied || i.deferred) await i.editReply(msg);
      else await (i as any).update(msg);
    } catch { /* interaksi kedaluwarsa */ }
  }
}

/** Router semua customId berawalan `otp:` (komponen dan modal). */
export async function handleOtpInteraction(app: App, i: Comp | ModalSubmitInteraction) {
  const parts = i.customId.split(':'); // ['otp', kind, ...]
  const kind = parts[1];
  const a = parts.slice(2);

  if (i.isStringSelectMenu()) {
    const v = i.values[0]!;
    if (kind === 'c') return safeUpdate(i, () => operatorScreen(app, v, 0));
    if (kind === 'o') return safeUpdate(i, () => serviceScreen(app, a[0]!, v, 0));
    if (kind === 's') return safeUpdate(i, () => confirmScreen(app, i.user.id, a[0]!, a[1]!, v));
    return;
  }

  if (i.isModalSubmit()) {
    if (kind === 'sm') {
      const q = clean(i.fields.getTextInputValue('q'));
      return safeUpdate(i, () => serviceScreen(app, a[0]!, a[1]!, 0, q));
    }
    return;
  }

  if (!i.isButton()) return;
  switch (kind) {
    case 'noop': return void (await i.deferUpdate());
    case 'cp': return safeUpdate(i, () => countryScreen(app, Number(a[0])));
    case 'op': return safeUpdate(i, () => operatorScreen(app, a[0]!, Number(a[1])));
    case 'sp': return safeUpdate(i, () => serviceScreen(app, a[0]!, a[1]!, Number(a[2] ?? 0), a.slice(3).join(':')));
    case 'sq': {
      const modal = new ModalBuilder().setCustomId(id('otp:sm', a[0]!, a[1]!)).setTitle('Cari service').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('q').setLabel('Nama service').setStyle(TextInputStyle.Short).setMaxLength(Q_MAX).setRequired(true),
        ),
      );
      return void (await i.showModal(modal));
    }
    case 'bk': {
      const to = a[0];
      if (to === 'c') return safeUpdate(i, () => countryScreen(app, 0));
      if (to === 'o') return safeUpdate(i, () => operatorScreen(app, a[1]!, 0));
      if (to === 's') return safeUpdate(i, () => serviceScreen(app, a[1]!, a[2]!, 0));
      return;
    }
    case 'n':
      return void (await i.update({ content: 'Pembelian dibatalkan.', embeds: [], components: [] }));
    case 'y':
      return confirmPurchase(app, i, a[0]!, a[1]!, a[2]!, Number(a[3]));
  }
}

async function confirmPurchase(app: App, i: ButtonInteraction, countryId: string, operatorId: string, serviceId: string, expectedPrice: number) {
  // hapus tombol segera supaya tidak bisa diklik dua kali
  await i.update({ content: '⏳ Memproses pesananmu...', embeds: [], components: [] });
  let result;
  try {
    result = await app.orders.purchase({ discordId: i.user.id, countryId, operatorId, serviceId, expectedPrice });
  } catch (e) {
    logger.error({ err: String(e) }, 'purchase melempar error');
    await app.notifier.notifyOwner(`🚨 Error tak terduga saat purchase user <@${i.user.id}>: ${(e as Error).message}. Cek order terbaru dengan /admin orders.`);
    return void (await i.editReply({ content: 'Terjadi kesalahan. Kalau saldomu terpotong, akan dicek dan dikembalikan oleh admin.', components: [] }));
  }
  if (result.ok) {
    return void (await i.editReply({ content: `✅ Nomor kamu sudah siap! Cek DM ya. (Order #${result.order.id})`, components: [] }));
  }
  if (result.code === 'PRICE_CHANGED') {
    const screen = await confirmScreen(app, i.user.id, countryId, operatorId, serviceId, `⚠️ ${result.message}`);
    return void (await i.editReply(screen as any));
  }
  const icon = result.code === 'FAILED_REFUNDED' ? '↩️' : '❌';
  await i.editReply({ content: `${icon} ${result.message}`, embeds: [], components: [] });
}

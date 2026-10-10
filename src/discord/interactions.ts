import { MessageFlags, type Interaction } from 'discord.js';
import { logger } from '../logger.js';
import { handleAdmin, handlePanelModal, PANEL_MODAL_ID } from './admin.js';
import type { App } from './app.js';
import { handleOtpInteraction, startBuy } from './buyFlow.js';
import { handleBalance, handleHistory } from './panel.js';
import { IDS } from './ui.js';

/** Router global: dipakai semua tombol/dropdown/modal supaya tetap hidup setelah restart. */
export async function onInteraction(app: App, i: Interaction) {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === 'admin') await handleAdmin(app, i);
      return;
    }
    if (i.isButton()) {
      const c = i.customId;
      if (c === IDS.panelBuy) return await startBuy(app, i);
      if (c === IDS.panelBalance) return await handleBalance(app, i);
      if (c === IDS.panelHistory) return await handleHistory(app, i);
      if (c.startsWith('otp:')) return await handleOtpInteraction(app, i);
      if (c.startsWith(IDS.dmCancel)) return await handleDmCancel(app, i);
      if (c.startsWith(IDS.dmResendLegacy)) return void (await i.reply({ content: 'Tombol ini sudah tidak dipakai.', flags: MessageFlags.Ephemeral }));
      return;
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('otp:')) return await handleOtpInteraction(app, i);
    if (i.isModalSubmit() && i.customId === PANEL_MODAL_ID) return await handlePanelModal(app, i);
    if (i.isModalSubmit() && i.customId.startsWith('otp:')) return await handleOtpInteraction(app, i);
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.stack : String(e) }, 'interaksi gagal');
    try {
      if (i.isRepliable()) {
        const msg = { content: 'Terjadi kesalahan. Coba lagi ya.', flags: MessageFlags.Ephemeral } as const;
        if (i.deferred || i.replied) await i.followUp(msg);
        else await i.reply(msg);
      }
    } catch { /* interaksi kedaluwarsa */ }
  }
}

async function handleDmCancel(app: App, i: import('discord.js').ButtonInteraction) {
  const orderId = i.customId.slice(IDS.dmCancel.length);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await app.orders.userCancel(orderId, i.user.id);
  await i.editReply(r.message);
}

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { OtpClient } from './clients/otp.js';
import { SaldoClient } from './clients/saldo.js';
import { loadConfig } from './config.js';
import { prisma } from './db.js';
import type { App } from './discord/app.js';
import { onInteraction } from './discord/interactions.js';
import { DiscordActivityLog, DiscordMessenger, DiscordNotifier } from './discord/messenger.js';
import { handlePanelCommand } from './discord/panel.js';
import { logger } from './logger.js';
import { registerCommands } from './registerCommands.js';
import { Catalog } from './services/catalog.js';
import { OrderService } from './services/orderService.js';
import { PrismaOrderStore } from './services/prismaStore.js';
import { recoverOrders } from './services/recovery.js';
import { Settings } from './services/settings.js';
import { PollWorker } from './services/worker.js';

async function main() {
  const cfg = loadConfig();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  const settings = new Settings(prisma, cfg);
  const store = new PrismaOrderStore(prisma);
  const saldo = new SaldoClient(cfg.SALDO_API_BASE_URL, cfg.SALDO_API_KEY);
  const otp = new OtpClient(cfg.OTP_API_BASE_URL, cfg.OTP_API_KEY);
  const catalog = new Catalog(otp, settings);
  const notifier = new DiscordNotifier(client, cfg.ownerIds, settings, cfg.LOG_CHANNEL_ID);
  const messenger = new DiscordMessenger(client, settings, cfg.CANCEL_MIN_MINUTES);
  const activity = new DiscordActivityLog(client, settings, cfg.LOG_CHANNEL_ID);
  const orders = new OrderService({ store, saldo, otp, catalog, settings, messenger, notifier, activity, maxActiveOrders: cfg.MAX_ACTIVE_ORDERS, cancelMinMinutes: cfg.CANCEL_MIN_MINUTES });
  const app: App = { cfg, client, settings, store, orders, catalog, saldo, otp, notifier };
  const worker = new PollWorker(store, otp, orders, cfg.POLL_INTERVAL_SECONDS * 1000);

  client.on(Events.InteractionCreate, (i) => void onInteraction(app, i));
  client.on(Events.MessageCreate, (m) => void handlePanelCommand(app, m).catch((e) => logger.error({ err: String(e) }, 'panel command gagal')));
  client.on(Events.Error, (e) => logger.error({ err: e.message }, 'discord client error'));

  client.once(Events.ClientReady, async (c) => {
    logger.info({ user: c.user.tag }, 'bot siap');
    try { await registerCommands(cfg); } catch (e) { logger.error({ err: String(e) }, 'register command gagal'); }
    await recoverOrders({ store, orders, notifier, settings });
    worker.start();
  });

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutdown');
    worker.stop();
    await client.destroy();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));

  await client.login(cfg.DISCORD_TOKEN);
}

main().catch((e) => {
  logger.fatal({ err: e instanceof Error ? e.message : String(e) }, 'gagal start');
  process.exit(1);
});

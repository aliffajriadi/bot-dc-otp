import { REST, Routes } from 'discord.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { adminCommand } from './discord/admin.js';
import { logger } from './logger.js';

export async function registerCommands(cfg: Config) {
  const rest = new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);
  const body = [adminCommand.toJSON()];
  const route = cfg.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(cfg.DISCORD_CLIENT_ID, cfg.DISCORD_GUILD_ID)
    : Routes.applicationCommands(cfg.DISCORD_CLIENT_ID);
  await rest.put(route, { body });
  logger.info({ scope: cfg.DISCORD_GUILD_ID ? 'guild' : 'global' }, 'slash command terdaftar');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerCommands(loadConfig()).catch((e) => { console.error(e); process.exit(1); });
}

import 'dotenv/config';
import { z } from 'zod';

const int = (def: number) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : Number(v)), z.number().int());

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),
  OWNER_DISCORD_IDS: z.string().default(''),
  PANEL_PREFIX: z.string().default('!'),
  DATABASE_URL: z.string().min(1),
  LOG_CHANNEL_ID: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  SALDO_API_BASE_URL: z.string().url(),
  SALDO_API_KEY: z.string().min(1),
  OTP_API_BASE_URL: z.string().url().default('https://otpcepat.org/api/handler_api.php'),
  OTP_API_KEY: z.string().min(1),
  ORDER_TIMEOUT_MINUTES: int(5),
  POLL_INTERVAL_SECONDS: int(5),
  DEFAULT_MARKUP_RP: int(1000),
  MAX_ACTIVE_ORDERS: int(3),
  CANCEL_MIN_MINUTES: int(5),
});

export type Config = Omit<z.infer<typeof schema>, 'OWNER_DISCORD_IDS'> & { ownerIds: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfigurasi .env tidak valid:\n${msg}`);
  }
  const { OWNER_DISCORD_IDS, ...rest } = parsed.data;
  const ownerIds = OWNER_DISCORD_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  return { ...rest, ownerIds };
}

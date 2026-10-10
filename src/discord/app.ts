import type { Client } from 'discord.js';
import type { Config } from '../config.js';
import type { OtpApi } from '../clients/otp.js';
import type { SaldoApi } from '../clients/saldo.js';
import type { Catalog } from '../services/catalog.js';
import type { OrderService } from '../services/orderService.js';
import type { Settings } from '../services/settings.js';
import type { AdminStore, Notifier } from '../services/types.js';

export interface App {
  cfg: Config;
  client: Client;
  settings: Settings;
  store: AdminStore;
  orders: OrderService;
  catalog: Catalog;
  saldo: SaldoApi;
  otp: OtpApi;
  notifier: Notifier;
}

export const isOwner = (app: App, id: string) => app.cfg.ownerIds.includes(id);

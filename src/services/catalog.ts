import type { Country, Operator, OtpApi, Service } from '../clients/otp.js';
import type { SettingsApi } from './types.js';
import { finalPrice } from './pricing.js';

export interface PricedService extends Service {
  markup: number;
  finalPrice: number;
}

/** Cache memori 60 detik + dedupe request yang sedang berjalan. */
export class Catalog {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private otp: OtpApi, private settings: SettingsApi, private ttlMs = 60_000, private now: () => number = Date.now) {}

  private cached<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (!fresh && hit && this.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: this.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  countries(fresh = false): Promise<Country[]> {
    return this.cached('c', fresh, () => this.otp.getCountries());
  }
  operators(countryId: string, fresh = false): Promise<Operator[]> {
    return this.cached(`o:${countryId}`, fresh, () => this.otp.getOperators(countryId));
  }
  async services(countryId: string, fresh = false): Promise<PricedService[]> {
    const raw = await this.cached(`s:${countryId}`, fresh, () => this.otp.getServices(countryId));
    const { global, overrides } = await this.settings.getMarkups();
    return raw.map((s) => {
      const override = overrides[s.id];
      return { ...s, markup: override ?? global, finalPrice: finalPrice(s.price, global, override) };
    });
  }
}

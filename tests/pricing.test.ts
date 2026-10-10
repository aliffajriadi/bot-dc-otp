import { describe, expect, it } from 'vitest';
import { effectiveMarkup, finalPrice } from '../src/services/pricing.js';
import { extractCode, toInt } from '../src/util/format.js';
import { maskUrl } from '../src/logger.js';

describe('pricing', () => {
  it('harga = provider + markup global', () => expect(finalPrice(2000, 1000)).toBe(3000));
  it('override menggantikan global (termasuk 0)', () => {
    expect(finalPrice(2000, 1000, 500)).toBe(2500);
    expect(finalPrice(2000, 1000, 0)).toBe(2000);
    expect(effectiveMarkup(1000, undefined)).toBe(1000);
  });
  it('menolak float / negatif', () => {
    expect(() => finalPrice(2000.5, 1000)).toThrow();
    expect(() => finalPrice(2000, -1)).toThrow();
  });
  it('toInt menormalkan string/number', () => {
    expect(toInt('2500')).toBe(2500);
    expect(toInt(2500)).toBe(2500);
    expect(toInt('2.500')).toBe(2500);
    expect(toInt('Rp 2500')).toBe(2500);
    expect(toInt('abc')).toBeNull();
  });
});

describe('util', () => {
  it('extractCode', () => {
    expect(extractCode('Kode WhatsApp kamu 123-456')).toBe('123456');
    expect(extractCode('Your code is 4821.')).toBe('4821');
    expect(extractCode('tidak ada kode')).toBeNull();
  });
  it('maskUrl menyembunyikan api_key', () => {
    const m = maskUrl('https://x.org/api?api_key=SECRET123&action=getCountries');
    expect(m).not.toContain('SECRET123');
    expect(m).toContain('action=getCountries');
  });
});

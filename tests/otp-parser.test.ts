import { describe, expect, it } from 'vitest';
import { ProviderError, parseBool, parseCountries, parseOperators, parseProviderOrder, parseServices, parseStatus } from '../src/clients/otp.js';

describe('parser provider', () => {
  it('parseBool menerima "true"/true/"false"/false', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool(true)).toBe(true);
    expect(parseBool('false')).toBe(false);
    expect(parseBool(false)).toBe(false);
    expect(parseBool('Waiting SMS')).toBeUndefined();
  });

  it.each([['true'], [true]])('get_order sukses dengan status=%s', (status) => {
    expect(parseProviderOrder({ status, order_id: 123, number: '628111' })).toEqual({ orderId: '123', phone: '628111' });
  });

  it.each([['false'], [false]])('get_order gagal dengan status=%s dan msg', (status) => {
    try {
      parseProviderOrder({ status, msg: 'NO BALANCE' });
      throw new Error('harus gagal');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).noBalance).toBe(true);
    }
  });

  it('services: price string/number dinormalkan ke integer', () => {
    const r = parseServices({ status: 'true', data: [{ id: 'wa', name: 'WhatsApp', price: '2500' }, { id: 'tg', name: 'Telegram', price: 3000 }, { id: 'x', name: 'Rusak', price: 'abc' }] });
    expect(r).toEqual([{ id: 'wa', name: 'WhatsApp', price: 2500 }, { id: 'tg', name: 'Telegram', price: 3000 }]);
  });

  it('countries dari array polos maupun dibungkus data', () => {
    expect(parseCountries([{ id: 1, name: 'Indonesia' }])).toEqual([{ id: '1', name: 'Indonesia' }]);
    expect(parseCountries({ status: true, data: [{ country_id: 2, country_name: 'Malaysia' }] })).toEqual([{ id: '2', name: 'Malaysia' }]);
  });

  it('countries: error provider dilempar', () => {
    expect(() => parseCountries({ status: 'false', msg: "You don't have Access!" })).toThrow(ProviderError);
  });

  it.each([
    ['Waiting SMS', 'waiting'], ['Recieved', 'received'], ['received', 'received'], ['RECIEVED', 'received'], ['Cancel', 'cancel'], ['Done', 'done'], ['Aneh', 'unknown'],
  ])('status "%s" -> %s', (raw, state) => {
    expect(parseStatus({ status: 'true', msg: raw }).state).toBe(state);
    expect(parseStatus({ status: true, status_order: raw }).state).toBe(state);
  });

  it('status: sms terisi -> received', () => {
    const s = parseStatus({ status: true, msg: 'Waiting SMS', sms: 'Kode 1234' });
    expect(s.state).toBe('received');
    expect(s.sms).toBe('Kode 1234');
  });
});

describe('format asli OTPCepat', () => {
  it('countries/services memakai countryID/serviceID, operator berupa array string', () => {
    expect(parseCountries({ status: true, data: [{ countryID: '6', countryName: 'Wakanda (Indo)' }] })).toEqual([{ id: '6', name: 'Wakanda (Indo)' }]);
    expect(parseServices({ status: true, countryID: '6', data: [{ serviceID: '5', serviceName: 'AfreecaTV', price: '1750' }] })).toEqual([{ id: '5', name: 'AfreecaTV', price: 1750 }]);
    expect(parseOperators({ status: true, data: ['random', 'indosat'] })).toEqual([{ id: 'random', name: 'random' }, { id: 'indosat', name: 'indosat' }]);
  });
});

import { isOrderGone } from '../src/clients/otp.js';
describe('isOrderGone', () => {
  it('mengenali WRONG/INVALID ORDER ID', () => {
    expect(isOrderGone('WRONG ORDER ID')).toBe(true);
    expect(isOrderGone('invalid order id ')).toBe(true);
    expect(isOrderGone('NO BALANCE')).toBe(false);
  });
});

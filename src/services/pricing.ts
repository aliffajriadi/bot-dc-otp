/** Semua dalam integer Rupiah. */
export function finalPrice(providerPrice: number, globalMarkup: number, serviceOverride?: number | null): number {
  const markup = serviceOverride ?? globalMarkup;
  if (![providerPrice, markup].every(Number.isInteger)) throw new Error('Harga harus integer');
  if (providerPrice < 0 || markup < 0) throw new Error('Harga tidak boleh negatif');
  return providerPrice + markup;
}

export function effectiveMarkup(globalMarkup: number, serviceOverride?: number | null): number {
  return serviceOverride ?? globalMarkup;
}

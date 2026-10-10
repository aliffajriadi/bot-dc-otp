export const rupiah = (n: number): string => `Rp${n.toLocaleString('id-ID')}`;

/** Ambil kode OTP (4-8 digit) dari teks SMS; null kalau tidak ketemu. */
export function extractCode(sms: string): string | null {
  const dashed = sms.match(/\b(\d{3})[-\s](\d{3})\b/);
  if (dashed) return `${dashed[1]}${dashed[2]}`;
  const m = sms.match(/(?<![\d.,])\d{4,8}(?!\d|[.,]\d)/);
  return m ? m[0] : null;
}

export function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    const n = Number(cleaned);
    if (cleaned !== '' && Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

const ISO: Record<string, string> = {
  ukraine: 'UA', kazakhstan: 'KZ', china: 'CN', philippines: 'PH', myanmar: 'MM', wakandaindo: 'ID', indonesia: 'ID', malaysia: 'MY',
  kenya: 'KE', tanzania: 'TZ', vietnam: 'VN', kyrgyzstan: 'KG', israel: 'IL', hongkong: 'HK', poland: 'PL', england: 'GB',
  unitedkingdom: 'GB', madagascar: 'MG', dcongo: 'CD', nigeria: 'NG', macao: 'MO', egypt: 'EG', india: 'IN', ireland: 'IE',
  cambodia: 'KH', laos: 'LA', haiti: 'HT', ivory: 'CI', gambia: 'GM', serbia: 'RS', yemen: 'YE', southafrica: 'ZA', romania: 'RO',
  colombia: 'CO', estonia: 'EE', azerbaijan: 'AZ', canada: 'CA', morocco: 'MA', ghana: 'GH', argentina: 'AR', uzbekistan: 'UZ',
  cameroon: 'CM', chad: 'TD', germany: 'DE', lithuania: 'LT', croatia: 'HR', thailand: 'TH', russia: 'RU', usa: 'US',
  unitedstates: 'US', singapore: 'SG', japan: 'JP', southkorea: 'KR', brazil: 'BR', mexico: 'MX', france: 'FR', spain: 'ES',
  italy: 'IT', netherlands: 'NL', turkey: 'TR', australia: 'AU', pakistan: 'PK', bangladesh: 'BD',
};

/** Emoji bendera dari nama negara provider; 🌐 kalau tidak dikenal. */
export function flagFor(countryName: string): string {
  const code = ISO[countryName.toLowerCase().replace(/[^a-z]/g, '')];
  if (!code) return '🌐';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

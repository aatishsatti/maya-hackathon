// Country calling codes, a STATIC table (ITU E.164 country codes), so Maya can tell a person which country a number's code belongs to. Nothing is looked up: no caller database, no owner, no name,
// no network, and the number is never stored or logged (it is read from the words of one turn, turned into a country name, and dropped). A code proves nothing about who is calling: numbers shown
// on a phone can be faked, so the note always says that in the same breath. Only codes that are certain are listed; any other code is reported as "not one I can place".
const CODES = {
  // zone 1: the North American numbering plan is shared; a few well-known area codes are named, the rest is "the US or Canada" (or another country sharing +1)
  1: 'the United States or Canada (the +1 code is also shared by several Caribbean countries)',
  7: 'Russia or Kazakhstan', 20: 'Egypt', 27: 'South Africa', 30: 'Greece', 31: 'the Netherlands', 32: 'Belgium', 33: 'France', 34: 'Spain', 36: 'Hungary', 39: 'Italy', 40: 'Romania', 41: 'Switzerland',
  43: 'Austria', 44: 'the United Kingdom', 45: 'Denmark', 46: 'Sweden', 47: 'Norway', 48: 'Poland', 49: 'Germany', 51: 'Peru', 52: 'Mexico', 53: 'Cuba', 54: 'Argentina', 55: 'Brazil', 56: 'Chile',
  57: 'Colombia', 58: 'Venezuela', 60: 'Malaysia', 61: 'Australia', 62: 'Indonesia', 63: 'the Philippines', 64: 'New Zealand', 65: 'Singapore', 66: 'Thailand', 81: 'Japan', 82: 'South Korea',
  84: 'Vietnam', 86: 'China', 90: 'Turkey', 91: 'India', 92: 'Pakistan', 93: 'Afghanistan', 94: 'Sri Lanka', 95: 'Myanmar', 98: 'Iran',
  212: 'Morocco', 213: 'Algeria', 216: 'Tunisia', 218: 'Libya', 220: 'Gambia', 221: 'Senegal', 233: 'Ghana', 234: 'Nigeria', 237: 'Cameroon', 243: 'the Democratic Republic of the Congo', 250: 'Rwanda',
  251: 'Ethiopia', 254: 'Kenya', 255: 'Tanzania', 256: 'Uganda', 260: 'Zambia', 263: 'Zimbabwe', 351: 'Portugal', 352: 'Luxembourg', 353: 'Ireland', 354: 'Iceland', 358: 'Finland', 359: 'Bulgaria',
  370: 'Lithuania', 371: 'Latvia', 372: 'Estonia', 380: 'Ukraine', 381: 'Serbia', 385: 'Croatia', 386: 'Slovenia', 420: 'Czechia', 421: 'Slovakia', 852: 'Hong Kong', 853: 'Macau', 855: 'Cambodia',
  856: 'Laos', 880: 'Bangladesh', 886: 'Taiwan', 960: 'the Maldives', 961: 'Lebanon', 962: 'Jordan', 963: 'Syria', 964: 'Iraq', 965: 'Kuwait', 966: 'Saudi Arabia', 967: 'Yemen', 968: 'Oman',
  971: 'the United Arab Emirates', 972: 'Israel', 973: 'Bahrain', 974: 'Qatar', 975: 'Bhutan', 976: 'Mongolia', 977: 'Nepal', 992: 'Tajikistan', 993: 'Turkmenistan', 994: 'Azerbaijan',
  995: 'Georgia', 996: 'Kyrgyzstan', 998: 'Uzbekistan',
};
// Caribbean numbers that look like "+1" calls from the US but are another country: named because prize and lottery calls from them are well known.
const NANP = { 876: 'Jamaica', 809: 'the Dominican Republic', 829: 'the Dominican Republic', 849: 'the Dominican Republic', 868: 'Trinidad and Tobago', 242: 'the Bahamas', 246: 'Barbados', 473: 'Grenada', 284: 'the British Virgin Islands', 649: 'the Turks and Caicos Islands' };

// An international number in the words: "+" or "00", then the digits (spaces, dots, dashes and brackets allowed). A number with no + / 00 has no code to read. Returns [{ code, country }].
function numbersIn(text) {
  const out = [], t = String(text || '');
  for (const m of t.matchAll(/(?:^|[^\w])(?:\+|00)[\s(.-]*(\d[\d\s().-]{5,18}\d)/g)) {
    const d = m[1].replace(/\D/g, ''); if (d.length < 7 || d.length > 15) continue;
    let code = null, country = null;
    if (d[0] === '1') { code = '1'; country = NANP[d.slice(1, 4)] || CODES[1]; }
    else for (const n of [3, 2, 1]) if (CODES[d.slice(0, n)] && d.slice(0, n) !== '1') { code = d.slice(0, n); country = CODES[code]; break; }
    out.push({ code: code || d.slice(0, 3), country: country || null });
    if (out.length >= 2) break;
  }
  return out;
}
// The fact for Maya (never the number itself): which country the code belongs to, and, in the same reply, that the number shown can be faked.
function fact(text) {
  const ns = numbersIn(text); if (!ns.length) return '';
  const first = ns[0];
  const where = first.country ? `the country code +${first.code} belongs to ${first.country}` : `the country code that starts that number (+${first.code}) is not one you can place`;
  return `A PHONE NUMBER WITH A COUNTRY CODE: they gave a number and ${where}. In THIS reply, in your own words and in one or two short sentences: tell them that country (or that you cannot place the code), and say that the number shown on a phone can be faked, so a country code alone does not prove who is calling. You did NOT look the number up and you cannot: never say who owns it, never give a caller or company name, never say it is safe or not safe because of the code. Do not repeat the digits back.`;
}
module.exports = { numbersIn, fact, CODES };

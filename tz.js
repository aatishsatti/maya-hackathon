// Time zone, found automatically, in this order of trust:
//   device : the phone or browser says its own zone (the Maya app and the web page send it with every call, chat and ring stream) - always wins
//   manual : the family chose it in the dashboard - ONLY offered when nothing above could find it; never a required step
//   ip     : where the senior's internet connection is (a lookup of the connecting address, only when the zone is still unknown; the address is not kept)
//   phone  : the country code of their linked WhatsApp number, only for countries with ONE time zone (a country with several is not guessed)
// With the zone known, clock times like "at 8" just work, and quiet hours apply. Nothing here is logged with an address or a number.
'use strict';
const RANK = { phone: 0, ip: 1, manual: 2, device: 3 };
const valid = (tz) => { try { return Boolean(tz) && typeof tz === 'string' && tz.length < 60 && Boolean(new Intl.DateTimeFormat('en-US', { timeZone: tz })); } catch { return false; } };

// Country calling codes whose country has a single time zone (longest code first when matching). Countries with several zones (US/CA +1, Russia +7, Mexico, Brazil, Australia, Indonesia ...) are left out on purpose.
const ONE_ZONE = { 44: 'Europe/London', 91: 'Asia/Kolkata', 33: 'Europe/Paris', 49: 'Europe/Berlin', 39: 'Europe/Rome', 34: 'Europe/Madrid', 31: 'Europe/Amsterdam', 32: 'Europe/Brussels', 41: 'Europe/Zurich', 43: 'Europe/Vienna', 46: 'Europe/Stockholm',
  47: 'Europe/Oslo', 45: 'Europe/Copenhagen', 358: 'Europe/Helsinki', 353: 'Europe/Dublin', 351: 'Europe/Lisbon', 48: 'Europe/Warsaw', 30: 'Europe/Athens', 90: 'Europe/Istanbul', 972: 'Asia/Jerusalem', 971: 'Asia/Dubai', 966: 'Asia/Riyadh',
  92: 'Asia/Karachi', 880: 'Asia/Dhaka', 94: 'Asia/Colombo', 977: 'Asia/Kathmandu', 65: 'Asia/Singapore', 60: 'Asia/Kuala_Lumpur', 66: 'Asia/Bangkok', 84: 'Asia/Ho_Chi_Minh', 63: 'Asia/Manila', 81: 'Asia/Tokyo', 82: 'Asia/Seoul',
  86: 'Asia/Shanghai', 852: 'Asia/Hong_Kong', 886: 'Asia/Taipei', 20: 'Africa/Cairo', 234: 'Africa/Lagos', 254: 'Africa/Nairobi', 27: 'Africa/Johannesburg', 233: 'Africa/Accra', 64: 'Pacific/Auckland', 57: 'America/Bogota', 51: 'America/Lima',
  54: 'America/Argentina/Buenos_Aires', 58: 'America/Caracas', 56: 'America/Santiago' };
function fromPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  for (const len of [3, 2, 1]) { const z = ONE_ZONE[d.slice(0, len)]; if (z) return z; }
  return null;
}

// The two automatic GUESSES (the connection, the phone number's country) can be switched off with MAYA_TZ_GUESS=off; they are off by default inside the test runner, which links made-up numbers, unless MAYA_TZ_GUESS=on.
const guessing = () => (process.env.MAYA_TZ_GUESS === 'on') || (process.env.MAYA_TZ_GUESS !== 'off' && !process.env.NODE_TEST_CONTEXT);
const isPrivate = (ip) => !ip || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip);
const deps = {
  // ip -> IANA zone name or null. The default asks a public geolocation service over https; tests replace it. A failure is quiet: the zone just stays unknown.
  geoTz: async (ip) => {
    const r = await globalThis.fetch(`https://ipapi.co/${encodeURIComponent(ip)}/timezone/`, { signal: AbortSignal.timeout(3000), headers: { 'user-agent': 'maya' } });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return valid(t) ? t : null;
  },
};
const tried = new Map();   // profileId -> when an address lookup was last tried (once every 6 hours at most, only while the zone is unknown)
function setZone(p, tz, source, save) {
  if (!valid(tz)) return false;
  const cur = p.tz ? (RANK[p.tzSource] != null ? RANK[p.tzSource] : RANK.device) : -1;   // a zone saved before sources existed came from a device
  if (RANK[source] < cur) return false;
  if (p.tz === tz && p.tzSource === source) return false;
  p.tz = tz; p.tzSource = source; if (save) save(p.id);
  return true;
}
async function learnFromIp(care, id, ip) {
  const p = care.get(id);
  if (!p || p.tz || !guessing() || isPrivate(ip)) return false;
  const now = Date.now(); if (now - (tried.get(id) || 0) < 6 * 3600000) return false; tried.set(id, now);
  let tz = null; try { tz = await deps.geoTz(ip); } catch { tz = null; }
  const q = care.get(id);
  return Boolean(tz && q && !q.tz && care.setTimezone(id, tz, 'ip'));
}
function learnFromPhone(care, id, phone) {
  const p = care.get(id); if (!p || p.tz || !guessing()) return false;
  const tz = fromPhone(phone); return Boolean(tz && care.setTimezone(id, tz, 'phone'));
}
const clientIp = (req) => String((req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '').trim().replace(/^::ffff:/, '');
const reset = () => tried.clear();

module.exports = { valid, fromPhone, setZone, learnFromIp, learnFromPhone, clientIp, deps, reset, RANK };

'use strict';
// Country without a GeoIP database and without storing IPs:
// 1) a country header from your proxy/CDN (Cloudflare, Vercel, Fly) if present, else
// 2) the visitor's browser time zone, mapped to its country (accurate for most time zones).

const TZ = {
  // Americas
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US',
  'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Detroit': 'US', 'America/Indiana/Indianapolis': 'US', 'America/Boise': 'US',
  'America/Kentucky/Louisville': 'US', 'America/Juneau': 'US', 'America/Adak': 'US', 'America/Menominee': 'US', 'America/Puerto_Rico': 'PR',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA',
  'America/St_Johns': 'CA', 'America/Regina': 'CA', 'America/Montreal': 'CA', 'America/Mexico_City': 'MX', 'America/Monterrey': 'MX',
  'America/Tijuana': 'MX', 'America/Cancun': 'MX', 'America/Guadalajara': 'MX', 'America/Merida': 'MX', 'America/Chihuahua': 'MX', 'America/Hermosillo': 'MX',
  'America/Bogota': 'CO', 'America/Lima': 'PE', 'America/Caracas': 'VE', 'America/Santiago': 'CL', 'America/Sao_Paulo': 'BR',
  'America/Fortaleza': 'BR', 'America/Recife': 'BR', 'America/Bahia': 'BR', 'America/Manaus': 'BR', 'America/Belem': 'BR',
  'America/Argentina/Buenos_Aires': 'AR', 'America/Buenos_Aires': 'AR', 'America/Argentina/Cordoba': 'AR', 'America/Montevideo': 'UY',
  'America/Asuncion': 'PY', 'America/La_Paz': 'BO', 'America/Guayaquil': 'EC', 'America/Panama': 'PA', 'America/Costa_Rica': 'CR',
  'America/Guatemala': 'GT', 'America/El_Salvador': 'SV', 'America/Tegucigalpa': 'HN', 'America/Managua': 'NI', 'America/Havana': 'CU',
  'America/Santo_Domingo': 'DO', 'America/Port-au-Prince': 'HT', 'America/Jamaica': 'JM', 'America/Port_of_Spain': 'TT', 'America/Barbados': 'BB',
  'America/Martinique': 'MQ', 'America/Guadeloupe': 'GP', 'America/Cayenne': 'GF', 'America/Paramaribo': 'SR', 'America/Guyana': 'GY', 'America/Nassau': 'BS',
  // Europe
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Lisbon': 'PT', 'Atlantic/Madeira': 'PT', 'Atlantic/Azores': 'PT', 'Europe/Madrid': 'ES', 'Atlantic/Canary': 'ES',
  'Europe/Paris': 'FR', 'Europe/Brussels': 'BE', 'Europe/Amsterdam': 'NL', 'Europe/Luxembourg': 'LU', 'Europe/Berlin': 'DE', 'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT', 'Europe/Rome': 'IT', 'Europe/Malta': 'MT', 'Europe/Monaco': 'MC', 'Europe/Copenhagen': 'DK', 'Europe/Oslo': 'NO',
  'Europe/Stockholm': 'SE', 'Europe/Helsinki': 'FI', 'Atlantic/Reykjavik': 'IS', 'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Bratislava': 'SK',
  'Europe/Budapest': 'HU', 'Europe/Ljubljana': 'SI', 'Europe/Zagreb': 'HR', 'Europe/Belgrade': 'RS', 'Europe/Sarajevo': 'BA', 'Europe/Skopje': 'MK',
  'Europe/Podgorica': 'ME', 'Europe/Tirane': 'AL', 'Europe/Athens': 'GR', 'Europe/Sofia': 'BG', 'Europe/Bucharest': 'RO', 'Europe/Chisinau': 'MD',
  'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Minsk': 'BY', 'Europe/Vilnius': 'LT', 'Europe/Riga': 'LV', 'Europe/Tallinn': 'EE',
  'Europe/Moscow': 'RU', 'Europe/Samara': 'RU', 'Asia/Yekaterinburg': 'RU', 'Asia/Novosibirsk': 'RU', 'Asia/Vladivostok': 'RU', 'Europe/Kaliningrad': 'RU',
  'Europe/Istanbul': 'TR', 'Asia/Nicosia': 'CY', 'Europe/Andorra': 'AD', 'Europe/Gibraltar': 'GI',
  // Africa
  'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Algiers': 'DZ', 'Africa/Tunis': 'TN', 'Africa/Tripoli': 'LY', 'Africa/Lagos': 'NG',
  'Africa/Accra': 'GH', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Bamako': 'ML', 'Africa/Ouagadougou': 'BF', 'Africa/Niamey': 'NE',
  'Africa/Conakry': 'GN', 'Africa/Lome': 'TG', 'Africa/Porto-Novo': 'BJ', 'Africa/Douala': 'CM', 'Africa/Libreville': 'GA', 'Africa/Kinshasa': 'CD',
  'Africa/Lubumbashi': 'CD', 'Africa/Brazzaville': 'CG', 'Africa/Bangui': 'CF', 'Africa/Ndjamena': 'TD', 'Africa/Luanda': 'AO', 'Africa/Nairobi': 'KE',
  'Africa/Addis_Ababa': 'ET', 'Africa/Kampala': 'UG', 'Africa/Dar_es_Salaam': 'TZ', 'Africa/Kigali': 'RW', 'Africa/Bujumbura': 'BI', 'Africa/Khartoum': 'SD',
  'Africa/Mogadishu': 'SO', 'Africa/Djibouti': 'DJ', 'Africa/Johannesburg': 'ZA', 'Africa/Harare': 'ZW', 'Africa/Lusaka': 'ZM', 'Africa/Maputo': 'MZ',
  'Africa/Windhoek': 'NA', 'Africa/Gaborone': 'BW', 'Indian/Antananarivo': 'MG', 'Indian/Mauritius': 'MU', 'Indian/Reunion': 'RE', 'Africa/Freetown': 'SL',
  'Africa/Monrovia': 'LR', 'Africa/Nouakchott': 'MR', 'Africa/Banjul': 'GM', 'Africa/Bissau': 'GW', 'Atlantic/Cape_Verde': 'CV', 'Africa/Malabo': 'GQ',
  // Middle East & Asia
  'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW', 'Asia/Bahrain': 'BH', 'Asia/Muscat': 'OM', 'Asia/Tehran': 'IR',
  'Asia/Baghdad': 'IQ', 'Asia/Amman': 'JO', 'Asia/Beirut': 'LB', 'Asia/Damascus': 'SY', 'Asia/Jerusalem': 'IL', 'Asia/Tel_Aviv': 'IL', 'Asia/Gaza': 'PS',
  'Asia/Karachi': 'PK', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dhaka': 'BD', 'Asia/Kathmandu': 'NP', 'Asia/Colombo': 'LK', 'Asia/Kabul': 'AF',
  'Asia/Tashkent': 'UZ', 'Asia/Almaty': 'KZ', 'Asia/Bishkek': 'KG', 'Asia/Baku': 'AZ', 'Asia/Tbilisi': 'GE', 'Asia/Yerevan': 'AM',
  'Asia/Bangkok': 'TH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Saigon': 'VN', 'Asia/Jakarta': 'ID', 'Asia/Makassar': 'ID', 'Asia/Jayapura': 'ID',
  'Asia/Kuala_Lumpur': 'MY', 'Asia/Singapore': 'SG', 'Asia/Manila': 'PH', 'Asia/Yangon': 'MM', 'Asia/Phnom_Penh': 'KH', 'Asia/Vientiane': 'LA',
  'Asia/Shanghai': 'CN', 'Asia/Chongqing': 'CN', 'Asia/Urumqi': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Macau': 'MO', 'Asia/Taipei': 'TW',
  'Asia/Seoul': 'KR', 'Asia/Pyongyang': 'KP', 'Asia/Tokyo': 'JP', 'Asia/Ulaanbaatar': 'MN',
  // Oceania
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU',
  'Australia/Hobart': 'AU', 'Australia/Darwin': 'AU', 'Pacific/Auckland': 'NZ', 'Pacific/Fiji': 'FJ', 'Pacific/Port_Moresby': 'PG',
  'Pacific/Tahiti': 'PF', 'Pacific/Noumea': 'NC', 'Pacific/Guam': 'GU',
};

const COUNTRY_NAMES = (() => {
  const names = {};
  let dn = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch {}
  for (const code of new Set(Object.values(TZ))) names[code] = dn ? dn.of(code) : code;
  return new Proxy(names, { get: (t, k) => t[k] ?? (dn && typeof k === 'string' && /^[A-Z]{2}$/.test(k) ? dn.of(k) : undefined) });
})();

function countryFromTimezone(tz) {
  return TZ[tz] || null;
}

module.exports = { countryFromTimezone, COUNTRY_NAMES };

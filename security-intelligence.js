const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:)}\]]+$/;
const SHORTENERS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd',
  'buff.ly', 'cutt.ly', 'rb.gy', 'tiny.cc', 'shorturl.at', 'lnkd.in'
]);
const BRAND_DOMAINS = new Map([
  ['paypal', ['paypal.com']],
  ['google', ['google.com', 'google.co.in']],
  ['microsoft', ['microsoft.com', 'live.com', 'microsoftonline.com']],
  ['apple', ['apple.com', 'icloud.com']],
  ['amazon', ['amazon.com', 'amazon.in']],
  ['facebook', ['facebook.com']],
  ['instagram', ['instagram.com']],
  ['whatsapp', ['whatsapp.com']],
  ['netflix', ['netflix.com']],
  ['sbi', ['sbi.co.in', 'onlinesbi.sbi']]
]);
const SUSPICIOUS_PATH_TERMS = [
  'verify', 'password', 'login', 'signin', 'account', 'wallet',
  'payment', 'claim', 'prize', 'gift', 'recovery', 'urgent',
  'suspend', 'unlock', 'otp', 'kyc'
];

function trimUrlCandidate(candidate) {
  return String(candidate || '').replace(TRAILING_PUNCTUATION, '').slice(0, 2048);
}

export function extractHttpUrls(text, limit = 5) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const results = [];
  const seen = new Set();
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimUrlCandidate(match[0]);
    const normalized = candidate.toLowerCase().startsWith('www.') ? 'https://' + candidate : candidate;
    let parsed;
    try { parsed = new URL(normalized); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) continue;
    const canonical = parsed.href;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    results.push(canonical);
    if (results.length >= Math.min(5, Math.max(1, limit))) break;
  }
  return results;
}

function isIpAddress(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function isOfficialBrandDomain(hostname, domains) {
  return domains.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
}

/**
 * Local, offline URL pattern inspection only. It deliberately performs no DNS
 * resolution, HTTP request, redirect following, or external reputation lookup.
 */
export function inspectUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input));
  } catch {
    return { url: String(input || '').slice(0, 2048), hostname: '', localScore: 100, severity: 'critical', signals: ['invalid_url'], reputationStatus: 'not_checked' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const signals = [];
  let score = 0;
  const add = (code, weight) => { if (!signals.includes(code)) { signals.push(code); score += weight; } };

  if (!['http:', 'https:'].includes(parsed.protocol)) add('unsupported_protocol', 80);
  if (parsed.protocol === 'http:') add('unencrypted_http', 12);
  if (parsed.username || parsed.password) add('embedded_credentials', 50);
  if (isIpAddress(hostname)) add('ip_address_host', 35);
  if (hostname.split('.').some((part) => part.startsWith('xn--'))) add('punycode_hostname', 35);
  if (SHORTENERS.has(hostname)) add('url_shortener', 24);
  if (parsed.port && !['80', '443'].includes(parsed.port)) add('unusual_port', 12);

  const labels = hostname.split('.').filter(Boolean);
  if (labels.length >= 5) add('deeply_nested_hostname', 10);

  const pathAndQuery = (parsed.pathname + ' ' + parsed.search).toLowerCase();
  const matchedTerms = SUSPICIOUS_PATH_TERMS.filter((term) => new RegExp('(?:^|[^a-z0-9])' + term + '(?:[^a-z0-9]|$)', 'i').test(pathAndQuery));
  if (matchedTerms.length) add('sensitive_or_urgent_url_path', Math.min(24, matchedTerms.length * 8));

  for (const [brand, domains] of BRAND_DOMAINS) {
    const brandLike = labels.some((label) => label === brand || label.startsWith(brand + '-') || label.endsWith('-' + brand));
    if (brandLike && !isOfficialBrandDomain(hostname, domains)) {
      add('possible_brand_impersonation', 45);
      break;
    }
  }

  score = Math.min(100, score);
  const severity = score >= 85 ? 'critical' : score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low';
  return {
    url: parsed.href.slice(0, 2048),
    hostname,
    localScore: score,
    severity,
    signals,
    reputationStatus: 'not_checked'
  };
}

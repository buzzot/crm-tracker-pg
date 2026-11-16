'use strict';
// Send email through Mailgun's HTTPS API (works where SMTP ports are blocked, e.g. Railway Hobby).
// Railway env:
//   MAILGUN_API_KEY   Mailgun private API key (Mailgun → API Security). Required.
//   MAILGUN_REGION    'us' (default) or 'eu', matching where the domain was created in Mailgun.
// The sending domain is the domain of the From address (e.g. samyouusa.com), which must be
// added and verified in Mailgun (SPF + DKIM DNS records).

function apiBase() { return String(process.env.MAILGUN_REGION || 'us').toLowerCase() === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'; }
function isConfigured() { return !!process.env.MAILGUN_API_KEY; }
function authHeader() { return 'Basic ' + Buffer.from('api:' + process.env.MAILGUN_API_KEY).toString('base64'); }
const domainOf = (email) => String(email || '').split('@')[1] || '';

function notConfigured() {
  const e = new Error('Mailgun sending is not set up on the server. Add MAILGUN_API_KEY in Railway → Variables.');
  e.code = 'MAILGUN_NOT_CONFIGURED';
  return e;
}

async function request(method, path, body) {
  if (!isConfigured()) throw notConfigured();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(apiBase() + path, { method, body, signal: ctrl.signal, headers: { Authorization: authHeader(), Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'Mailgun did not respond in time.' : 'Could not reach Mailgun.');
    err.code = 'MAILGUN_NETWORK';
    throw err;
  } finally { clearTimeout(t); }
}

function friendly(status, data, domain) {
  const m = String((data && data.message) || '');
  if (status === 401) return 'Mailgun rejected the API key. Check MAILGUN_API_KEY (and MAILGUN_REGION if your domain is in the EU region).';
  if (status === 404 || /domain not found/i.test(m)) return `The domain ${domain} is not added in Mailgun yet. Add it under Mailgun → Sending → Domains, then add the DNS records shown in My Profile.`;
  if (/not verified|unverified|activate/i.test(m)) return `The domain ${domain} is not verified in Mailgun yet. Add the DNS records shown in My Profile and click Verify in Mailgun.`;
  if (/sandbox|authorized recipients/i.test(m)) return 'Your Mailgun account can only send to authorised recipients (sandbox). Add a payment method or authorise the recipient in Mailgun.';
  if (status === 429) return 'Mailgun sending limit reached. Try again in a few minutes.';
  return ('Mailgun error ' + status + (m ? ': ' + m : '')).slice(0, 240);
}

/**
 * mail: { from:{name,email}, to:[{name,email}], cc:[...], bcc:[...], subject, text, html, inReplyTo, references }
 * → { messageId }
 */
async function send(mail, { formatAddress }) {
  const domain = domainOf(mail.from.email);
  if (!domain) throw new Error('The From address is not valid.');
  const fd = new FormData();
  fd.append('from', formatAddress(mail.from));
  mail.to.forEach((a) => fd.append('to', formatAddress(a)));
  (mail.cc || []).forEach((a) => fd.append('cc', formatAddress(a)));
  (mail.bcc || []).forEach((a) => fd.append('bcc', formatAddress(a)));
  fd.append('subject', mail.subject || '');
  fd.append('text', mail.text || '');
  if (mail.html) fd.append('html', mail.html);
  if (mail.inReplyTo) fd.append('h:In-Reply-To', mail.inReplyTo);
  if (mail.references) fd.append('h:References', mail.references);
  fd.append('h:Reply-To', formatAddress(mail.from));
  const r = await request('POST', `/v3/${encodeURIComponent(domain)}/messages`, fd);
  if (!r.ok) { const e = new Error(friendly(r.status, r.data, domain)); e.code = 'MAILGUN_SEND'; e.status = r.status; throw e; }
  const id = String(r.data.id || '').trim();
  return { messageId: id ? (id.startsWith('<') ? id : '<' + id + '>') : null };
}

// Domain verification status + the DNS records the user must add (for the profile page)
async function domainStatus(domain) {
  if (!isConfigured()) return { configured: false };
  const r = await request('GET', `/v3/domains/${encodeURIComponent(domain)}`);
  if (r.status === 404) return { configured: true, exists: false, domain };
  if (!r.ok) return { configured: true, exists: null, domain, error: friendly(r.status, r.data, domain) };
  const d = r.data.domain || {};
  const records = (r.data.sending_dns_records || []).map((x) => ({
    type: x.record_type, name: x.name, value: x.value, valid: x.valid === 'valid',
  }));
  // Mailgun suggests a fresh SPF record; a domain may only have one, so merge with the existing one.
  const spf = records.find((x) => x.type === 'TXT' && /^v=spf1/i.test(x.value || ''));
  if (spf && !spf.valid) {
    const existing = await currentSpf(spf.name || domain);
    if (existing && !/include:mailgun\.org/i.test(existing)) {
      spf.value = /\s[~?+-]?all\s*$/i.test(existing) ? existing.replace(/\s([~?+-]?all)\s*$/i, ' include:mailgun.org $1') : existing + ' include:mailgun.org';
      spf.note = 'Edit your existing SPF record to this value (do not add a second one).';
    }
  }
  return { configured: true, exists: true, domain, state: d.state || 'unknown', active: d.state === 'active', records };
}

async function currentSpf(name) {
  try {
    const txt = await require('dns').promises.resolveTxt(name);
    const rec = txt.map((parts) => parts.join('')).find((t) => /^v=spf1/i.test(t));
    return rec || null;
  } catch (_) { return null; }
}

module.exports = { isConfigured, send, domainStatus, domainOf };

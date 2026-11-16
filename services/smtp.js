'use strict';
// Minimal SMTP client (no dependencies): SSL (465) or STARTTLS (587), AUTH PLAIN/LOGIN,
// UTF-8 headers, multipart/alternative (text + HTML). Enough for sending CRM emails
// from a user's own mailbox (Microsoft 365, Google Workspace, Tencent Exmail, Aliyun…).
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const TIMEOUT_MS = 30000;

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

// RFC 2047 encoded-word only when needed (non-ASCII)
function encodeHeader(value) {
  const v = String(value || '');
  return /[^\x20-\x7e]/.test(v) ? '=?UTF-8?B?' + b64(v) + '?=' : v;
}

// "Name <a@b.c>" → { name, email }
function parseAddress(s) {
  const t = String(s || '').trim();
  const m = t.match(/^\s*"?([^"<]*?)"?\s*<\s*([^>\s]+@[^>\s]+)\s*>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  const e = t.match(/([^\s<>",;]+@[^\s<>",;]+)/);
  return e ? { name: '', email: e[1] } : null;
}
function parseAddressList(s) {
  return String(s || '').split(/[,;\n]+/).map(parseAddress).filter(Boolean);
}
function formatAddress(a) {
  if (!a) return '';
  return a.name ? `${encodeHeader(a.name.replace(/"/g, ''))} <${a.email}>` : a.email;
}
const isEmail = (e) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(String(e || ''));

function wrapBase64(buf) { return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n'); }

function buildMessage({ from, to, cc, subject, text, html, messageId, inReplyTo, references }) {
  const boundary = 'b_' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(', ')}`,
    cc && cc.length ? `Cc: ${cc.map(formatAddress).join(', ')}` : null,
    `Subject: ${encodeHeader(subject || '')}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  const parts = [
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    wrapBase64(Buffer.from(text || '', 'utf8')),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    wrapBase64(Buffer.from(html || '', 'utf8')),
    `--${boundary}--`, '',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

// Line-oriented SMTP conversation over a (possibly upgraded) socket
class Conn {
  constructor(socket) { this.attach(socket); }
  attach(socket) {
    this.socket = socket; this.buf = ''; this.waiters = [];
    socket.setEncoding('utf8');
    socket.on('data', (d) => { this.buf += d; this.flush(); });
    socket.on('error', (e) => { this.fail(e); });
    socket.on('close', () => { this.fail(new Error('Connection closed by the mail server.')); });
    socket.setTimeout(TIMEOUT_MS, () => { this.fail(new Error('Mail server did not respond in time.')); socket.destroy(); });
  }
  fail(e) { const w = this.waiters; this.waiters = []; w.forEach((x) => x.reject(e)); this.dead = e; }
  flush() {
    // A full reply ends with a line "ddd <text>" (space, not dash)
    while (this.waiters.length) {
      const lines = this.buf.split('\r\n');
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) { if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) { end = i; break; } }
      if (end < 0) return;
      const reply = lines.slice(0, end + 1);
      this.buf = lines.slice(end + 1).join('\r\n');
      const code = parseInt(reply[end].slice(0, 3), 10);
      this.waiters.shift().resolve({ code, text: reply.map((l) => l.slice(4)).join('\n') });
    }
  }
  read() { return new Promise((resolve, reject) => { if (this.dead) return reject(this.dead); this.waiters.push({ resolve, reject }); this.flush(); }); }
  async cmd(line, expect) {
    this.socket.write(line + '\r\n');
    const r = await this.read();
    if (expect && !expect.includes(r.code)) {
      const shown = /^AUTH|^[A-Za-z0-9+/=]{8,}$/.test(line) ? '(credentials)' : line.split(' ')[0];
      const err = new Error(`${shown} failed: ${r.code} ${r.text}`.slice(0, 300));
      err.smtpCode = r.code; throw err;
    }
    return r;
  }
}

function connect({ host, port, secure }, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host, ...(secure === 'ssl' ? tlsOptions : {}) };
    const sock = secure === 'ssl' ? tls.connect(opts) : net.connect(opts);
    const ok = secure === 'ssl' ? 'secureConnect' : 'connect';
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`Could not reach ${host}:${port}.`)); }, TIMEOUT_MS);
    sock.once(ok, () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(new Error(`Could not connect to ${host}:${port} (${e.code || e.message}).`)); });
  });
}

/**
 * Send one message. settings: { host, port, secure: 'ssl'|'starttls'|'none', user, pass }
 * mail: { from:{name,email}, to:[...], cc:[...], subject, text, html, inReplyTo, references }
 * Returns { messageId, accepted:[emails] }.
 */
async function sendMail(settings, mail, { tlsOptions = {} } = {}) {
  const to = mail.to.filter((a) => isEmail(a.email));
  const cc = (mail.cc || []).filter((a) => isEmail(a.email));
  if (!to.length) throw new Error('Add at least one valid recipient.');
  const domain = (mail.from.email.split('@')[1] || 'localhost').toLowerCase();
  const messageId = `<${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;

  const sock = await connect(settings, tlsOptions);
  let c = new Conn(sock);
  try {
    let r = await c.read();
    if (r.code !== 220) throw new Error(`Mail server greeting failed: ${r.code}`);
    const helloName = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    r = await c.cmd(`EHLO ${helloName}`, [250]);

    if (settings.secure === 'starttls') {
      if (!/STARTTLS/i.test(r.text)) throw new Error('This server does not offer STARTTLS on this port. Try SSL on port 465.');
      await c.cmd('STARTTLS', [220]);
      sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error'); sock.setTimeout(0);
      const secured = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: settings.host, ...tlsOptions }, () => resolve(s));
        s.once('error', (e) => reject(new Error('TLS upgrade failed: ' + e.message)));
      });
      c = new Conn(secured);
      r = await c.cmd(`EHLO ${helloName}`, [250]);
    }

    if (settings.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(r.text)) {
        await c.cmd('AUTH PLAIN ' + b64('\0' + settings.user + '\0' + settings.pass), [235]);
      } else {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(b64(settings.user), [334]);
        await c.cmd(b64(settings.pass), [235]);
      }
    }

    await c.cmd(`MAIL FROM:<${mail.from.email}>`, [250]);
    const accepted = [];
    for (const a of [...to, ...cc]) {
      const rr = await c.cmd(`RCPT TO:<${a.email}>`);
      if (rr.code === 250 || rr.code === 251) accepted.push(a.email);
    }
    if (!accepted.length) throw new Error('The mail server rejected all recipients.');
    await c.cmd('DATA', [354]);
    const raw = buildMessage({ ...mail, to, cc, messageId });
    const stuffed = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    await c.cmd(stuffed + '\r\n.', [250]);
    try { await c.cmd('QUIT'); } catch (_) { /* ignore */ }
    return { messageId, accepted };
  } finally {
    try { c.socket.end(); } catch (_) { /* ignore */ }
  }
}

// Turn SMTP errors into advice a non-technical user can act on
function friendlyError(e, provider) {
  const m = String(e && e.message || e);
  if (/535|534|authentication|AUTH/i.test(m)) {
    if (provider === 'microsoft') return 'Sign-in was rejected. In Microsoft 365, "Authenticated SMTP" must be enabled for your mailbox, and if you use two-step sign-in you need an app password.';
    if (provider === 'google') return 'Sign-in was rejected. Google requires an App Password (Google Account → Security → 2-Step Verification → App passwords).';
    if (provider === 'tencent') return 'Sign-in was rejected. Tencent Exmail needs a client-specific password (Settings → Account → Client-specific password).';
    return 'Sign-in was rejected. Check the username and password (many providers require an app password).';
  }
  if (/Could not connect|Could not reach|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(m)) return 'Could not reach the mail server. Check the server name and port.';
  if (/STARTTLS|TLS/i.test(m)) return m;
  return m.replace(/\s+/g, ' ').slice(0, 240);
}

module.exports = { sendMail, buildMessage, parseAddress, parseAddressList, formatAddress, isEmail, friendlyError };

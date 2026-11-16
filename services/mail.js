'use strict';
// Email: mailbox settings, company tracking addresses, email log, threads, inbound routing.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { query } = require('../config/db');
const secret = require('./secret');
const smtp = require('./smtp');

// ── Schema (idempotent; same SQL as migrations/add-email.sql) ───────────────
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'add-email.sql'), 'utf8');
    schemaReady = query(sql).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const trackingDomain = () => process.env.EMAIL_DOMAIN || 'mg.samyoucrm.com';

// ── Provider presets (auto-detected from the domain's MX records) ───────────
const PROVIDERS = {
  microsoft: { label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, secure: 'starttls',
    help: 'Use your full email as username. Your IT admin may need to enable "Authenticated SMTP" for your mailbox. If you use two-step sign-in, create an app password.' },
  google: { label: 'Google Workspace / Gmail', host: 'smtp.gmail.com', port: 465, secure: 'ssl',
    help: 'Use an App Password, not your normal password: Google Account → Security → 2-Step Verification → App passwords.' },
  tencent: { label: 'Tencent Exmail (腾讯企业邮)', host: 'smtp.exmail.qq.com', port: 465, secure: 'ssl',
    help: 'Use a client-specific password: Exmail → Settings → Account → Client-specific password (客户端专用密码).' },
  aliyun: { label: 'Alibaba Cloud Enterprise Mail (阿里企业邮箱)', host: 'smtp.qiye.aliyun.com', port: 465, secure: 'ssl',
    help: 'Username is your full email. Use your mailbox password, or, if your admin turned on "third-party client security password" (三方客户端安全密码), generate one in webmail: Settings → Account security, and use that instead.' },
  netease: { label: 'NetEase Qiye (网易企业邮)', host: 'smtp.qiye.163.com', port: 465, secure: 'ssl',
    help: 'Enable SMTP in mailbox settings and use the client authorization code as password.' },
  zoho: { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: 'ssl', help: 'Use an app-specific password if two-factor sign-in is on.' },
  godaddy: { label: 'GoDaddy Email', host: 'smtpout.secureserver.net', port: 465, secure: 'ssl', help: 'Use your full email and mailbox password.' },
  other: { label: 'Other', host: '', port: 465, secure: 'ssl', help: 'Ask your email provider for the SMTP server, port and security type.' },
};

async function detectProvider(email) {
  const domain = String(email || '').split('@')[1];
  if (!domain) return { key: 'other', ...PROVIDERS.other, mx: [] };
  let mx = [];
  try { mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase()); } catch (_) { /* no MX */ }
  const all = mx.join(' ') + ' ' + domain;
  let key = 'other';
  if (/outlook\.com|protection\.outlook|office365|microsoft/.test(all)) key = 'microsoft';
  else if (/google\.com|googlemail|gmail\.com/.test(all)) key = 'google';
  else if (/exmail\.qq|qq\.com/.test(all)) key = 'tencent';
  else if (/mxhichina|aliyun|alibaba/.test(all)) key = 'aliyun';
  else if (/163\.com|netease|ym\.163/.test(all)) key = 'netease';
  else if (/zoho/.test(all)) key = 'zoho';
  else if (/secureserver\.net/.test(all)) key = 'godaddy';
  return { key, ...PROVIDERS[key], mx: mx.slice(0, 3) };
}

// ── Mailbox settings ────────────────────────────────────────────────────────
function mapSettings(r) {
  if (!r) return null;
  return {
    email: r.email, displayName: r.display_name, provider: r.provider,
    host: r.smtp_host, port: r.smtp_port, secure: r.smtp_secure, user: r.smtp_user,
    hasPassword: !!r.smtp_pass_enc, signature: r.signature || '',
    verifiedAt: r.verified_at, lastError: r.last_error, updatedAt: r.updated_at,
  };
}

async function getSettings(userId) {
  await ensureSchema();
  const r = await query('SELECT * FROM user_email_settings WHERE user_id=$1', [userId]);
  return mapSettings(r.rows[0]);
}

async function saveSettings(userId, s) {
  await ensureSchema();
  const email = String(s.email || '').trim().toLowerCase();
  if (!smtp.isEmail(email)) throw new Error('Enter a valid email address.');
  const host = String(s.host || '').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new Error('Enter the SMTP server name, e.g. smtp.office365.com.');
  const port = parseInt(s.port, 10);
  if (!(port > 0 && port < 65536)) throw new Error('Enter a valid port (usually 465 or 587).');
  const secure = s.secure === 'starttls' ? 'starttls' : 'ssl';
  const user = String(s.user || email).trim();
  const existing = await query('SELECT smtp_pass_enc FROM user_email_settings WHERE user_id=$1', [userId]);
  let passEnc = existing.rows[0] && existing.rows[0].smtp_pass_enc;
  if (s.password) passEnc = secret.encrypt(s.password);
  if (!passEnc) throw new Error('Enter the password (or app password) for this mailbox.');
  await query(
    `INSERT INTO user_email_settings (user_id, email, display_name, provider, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, signature, verified_at, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,NOW())
     ON CONFLICT (user_id) DO UPDATE SET email=$2, display_name=$3, provider=$4, smtp_host=$5, smtp_port=$6, smtp_secure=$7,
       smtp_user=$8, smtp_pass_enc=$9, signature=$10, verified_at=NULL, last_error=NULL, updated_at=NOW()`,
    [userId, email, String(s.displayName || '').trim() || null, s.provider || null, host, port, secure, user, passEnc, String(s.signature || '').slice(0, 2000) || null]
  );
  return getSettings(userId);
}

async function removeSettings(userId) {
  await ensureSchema();
  await query('DELETE FROM user_email_settings WHERE user_id=$1', [userId]);
}

async function smtpConfig(userId) {
  await ensureSchema();
  const r = await query('SELECT * FROM user_email_settings WHERE user_id=$1', [userId]);
  const row = r.rows[0];
  if (!row) { const e = new Error('Set up your email in My Profile first.'); e.code = 'NO_MAILBOX'; throw e; }
  let pass;
  try { pass = secret.decrypt(row.smtp_pass_enc); }
  catch (_) { const e = new Error('Your saved mailbox password can no longer be read. Re-enter it in My Profile.'); e.code = 'NO_MAILBOX'; throw e; }
  return { settings: mapSettings(row), conn: { host: row.smtp_host, port: row.smtp_port, secure: row.smtp_secure, user: row.smtp_user, pass } };
}

async function markVerified(userId, error) {
  await query('UPDATE user_email_settings SET verified_at=$2, last_error=$3, updated_at=NOW() WHERE user_id=$1',
    [userId, error ? null : new Date(), error ? String(error).slice(0, 500) : null]);
}

// ── Company tracking address: <slug>@<EMAIL_DOMAIN> ─────────────────────────
function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
}
async function companyAddress(company) {
  await ensureSchema();
  let alias = company.inboxAlias;
  if (!alias) {
    const r0 = await query('SELECT inbox_alias FROM companies WHERE id=$1', [company.id]);
    alias = r0.rows[0] && r0.rows[0].inbox_alias;
  }
  if (!alias) {
    const base = slugify(company.name);
    for (let i = 0; i < 50 && !alias; i++) {
      const candidate = i ? `${base}-${i + 1}` : base;
      try {
        const r = await query(`UPDATE companies SET inbox_alias=$2 WHERE id=$1 AND inbox_alias IS NULL
                               AND NOT EXISTS (SELECT 1 FROM companies WHERE lower(inbox_alias)=lower($2)) RETURNING inbox_alias`, [company.id, candidate]);
        if (r.rows[0]) alias = r.rows[0].inbox_alias;
      } catch (_) { /* unique race: try next */ }
    }
    if (!alias) alias = 'company-' + company.id;
  }
  return `${alias}@${trackingDomain()}`;
}
async function companyByAlias(localPart) {
  await ensureSchema();
  const lp = String(localPart || '').toLowerCase();
  const m = lp.match(/^company-([0-9a-f-]{36})$/);
  const r = m ? await query('SELECT id, name FROM companies WHERE id=$1', [m[1]])
              : await query('SELECT id, name FROM companies WHERE lower(inbox_alias)=$1', [lp]);
  return r.rows[0] || null;
}

// ── Messages & threads ──────────────────────────────────────────────────────
function normSubject(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 6; i++) t = t.replace(/^\s*(re|fw|fwd|aw|sv|回复|答复|转发)\s*[:：]\s*/i, '').replace(/^\[[^\]]{1,20}\]\s*/, '');
  return t.toLowerCase().replace(/\s+/g, ' ').trim() || '(no subject)';
}
async function threadKeyFor(companyId, subject, inReplyTo) {
  if (inReplyTo) {
    const r = await query('SELECT thread_key FROM email_messages WHERE message_id=$1 AND company_id IS NOT DISTINCT FROM $2 LIMIT 1', [inReplyTo, companyId]);
    if (r.rows[0] && r.rows[0].thread_key) return r.rows[0].thread_key;
  }
  return (companyId || 'none') + '|' + normSubject(subject);
}

function mapMessage(r) {
  return {
    id: r.id, companyId: r.company_id, projectId: r.project_id, direction: r.direction, status: r.status,
    from: r.from_addr || '', to: r.to_addrs || '', cc: r.cc_addrs || '', subject: r.subject || '', body: r.body_text || '',
    threadKey: r.thread_key, messageId: r.message_id, inReplyTo: r.in_reply_to, userId: r.user_id, userName: r.user_name || null,
    error: r.error, ai: r.ai || null, sentAt: r.sent_at, createdAt: r.created_at, updatedAt: r.updated_at, source: 'email',
  };
}

async function getMessage(id) {
  await ensureSchema();
  const r = await query('SELECT m.*, u.name AS user_name FROM email_messages m LEFT JOIN users u ON u.id=m.user_id WHERE m.id=$1', [id]);
  return r.rows[0] ? mapMessage(r.rows[0]) : null;
}

async function saveDraft({ id, companyId, projectId, userId, from, to, cc, subject, body, inReplyTo, ai }) {
  await ensureSchema();
  const key = await threadKeyFor(companyId, subject, inReplyTo);
  if (id) {
    const r = await query(`UPDATE email_messages SET project_id=$2, from_addr=$3, to_addrs=$4, cc_addrs=$5, subject=$6, body_text=$7,
        in_reply_to=$8, thread_key=$9, ai=COALESCE($10, ai), updated_at=NOW()
      WHERE id=$1 AND status IN ('draft','failed') AND user_id=$11 RETURNING id`,
      [id, projectId || null, from, to, cc, subject, body, inReplyTo || null, key, ai ? JSON.stringify(ai) : null, userId]);
    if (r.rows[0]) return r.rows[0].id;
  }
  const r = await query(`INSERT INTO email_messages (company_id, project_id, direction, status, from_addr, to_addrs, cc_addrs, subject, body_text, thread_key, in_reply_to, user_id, ai)
    VALUES ($1,$2,'out','draft',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [companyId, projectId || null, from, to, cc, subject, body, key, inReplyTo || null, userId, ai ? JSON.stringify(ai) : null]);
  return r.rows[0].id;
}

async function markSent(id, { messageId }) {
  await query(`UPDATE email_messages SET status='sent', message_id=$2, error=NULL, sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [id, messageId]);
}
async function markFailed(id, error) {
  await query(`UPDATE email_messages SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`, [id, String(error).slice(0, 500)]);
}
async function deleteDraft(id, userId) {
  await ensureSchema();
  await query(`DELETE FROM email_messages WHERE id=$1 AND user_id=$2 AND status IN ('draft','failed')`, [id, userId]);
}

async function listCompanyMessages(companyId) {
  await ensureSchema();
  const r = await query(`SELECT m.*, u.name AS user_name FROM email_messages m LEFT JOIN users u ON u.id=m.user_id
                         WHERE m.company_id=$1 ORDER BY COALESCE(m.sent_at, m.created_at) ASC`, [companyId]);
  return r.rows.map(mapMessage);
}

// Emails already logged as comments on this company's projects / activities (read-only in the log)
async function listLegacyEmails(companyId) {
  const r = await query(`
    SELECT cm.*, p.id AS proj_id, p.name AS proj_name FROM comments cm
    LEFT JOIN projects p   ON cm.entity_type='project'  AND p.id = cm.entity_id
    LEFT JOIN activities a ON cm.entity_type='activity' AND a.id = cm.entity_id
    WHERE (p.company_id=$1 OR a.company_id=$1)
      AND (cm.type='email' OR cm.link LIKE 'MANUAL:%"ch":"email"%')
    ORDER BY cm.created_at ASC`, [companyId]);
  return r.rows.map((row) => {
    let meta = null;
    if (String(row.link || '').startsWith('MANUAL:')) { try { meta = JSON.parse(row.link.slice(7)); } catch (_) { /* ignore */ } }
    const out = meta && meta.dir === 'out';
    return {
      id: 'c_' + row.id, commentId: row.id, companyId, projectId: row.proj_id, projectName: row.proj_name,
      direction: out ? 'out' : 'in', status: out ? 'sent' : 'received',
      from: row.author_name || '', to: (meta && meta.to) || '', cc: '', subject: row.email_subject || '', body: row.content || '',
      threadKey: companyId + '|' + normSubject(row.email_subject), createdAt: row.created_at, sentAt: row.created_at,
      source: row.entity_type === 'project' ? 'project' : 'activity', sourceLink: row.entity_type === 'project' ? `/projects/${row.entity_id}` : `/activities/${row.entity_id}`,
    };
  });
}

// Group messages into threads with a "what's next" status
function buildThreads(messages) {
  const map = new Map();
  for (const m of messages) {
    const k = m.threadKey || m.id;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  const threads = [];
  for (const [key, msgs] of map) {
    msgs.sort((a, b) => new Date(a.sentAt || a.createdAt) - new Date(b.sentAt || b.createdAt));
    const real = msgs.filter((m) => m.status !== 'draft');
    const drafts = msgs.filter((m) => m.status === 'draft' || m.status === 'failed');
    const last = real[real.length - 1] || null;
    let state = 'draft';
    if (last) {
      state = last.direction === 'in' ? 'reply' : 'waiting';
      // No movement for 30+ days: no longer an action item
      if (Date.now() - new Date(last.sentAt || last.createdAt).getTime() > 30 * 86400000) state = 'quiet';
    }
    const lastAt = last ? (last.sentAt || last.createdAt) : (drafts[drafts.length - 1] || {}).updatedAt;
    // Other party per message, de-duplicated by email address
    const byEmail = new Map();
    msgs.forEach((m) => {
      const a = smtp.parseAddress(m.direction === 'in' ? m.from : String(m.to).split(',')[0]);
      if (a && !byEmail.has(a.email.toLowerCase())) byEmail.set(a.email.toLowerCase(), a.name || a.email);
      else if (a && a.name && byEmail.get(a.email.toLowerCase()) === a.email) byEmail.set(a.email.toLowerCase(), a.name);
    });
    const people = [...byEmail.values()];
    const subjectSrc = (last || msgs[0]);
    threads.push({
      key, state, subject: subjectSrc.subject || '(no subject)', count: real.length, drafts: drafts.length,
      hasFailed: msgs.some((m) => m.status === 'failed'),
      last, lastAt, people: people.slice(0, 4), projectId: (msgs.find((m) => m.projectId) || {}).projectId || null,
      projectName: (msgs.find((m) => m.projectName) || {}).projectName || null,
      messages: msgs,
    });
  }
  const rank = { reply: 0, draft: 1, waiting: 2, quiet: 3 };
  threads.sort((a, b) => (rank[a.state] - rank[b.state]) || (new Date(b.lastAt) - new Date(a.lastAt)));
  return threads;
}

async function companyThreads(companyId) {
  const [mine, legacy] = await Promise.all([listCompanyMessages(companyId), listLegacyEmails(companyId).catch(() => [])]);
  return buildThreads([...mine, ...legacy]);
}

// ── Inbound (Mailgun) → company email log ───────────────────────────────────
async function recordInbound({ company, from, to, cc, subject, body, messageId, inReplyTo }) {
  await ensureSchema();
  // Our own CRM-sent emails come back via the CC: already logged, skip
  if (messageId) {
    const dup = await query('SELECT id FROM email_messages WHERE message_id=$1 LIMIT 1', [messageId]);
    if (dup.rows[0]) return { skipped: 'duplicate' };
  }
  // Sent by one of our users from their mail client (they CC'd the tracking address) → outgoing
  const sender = (smtp.parseAddress(from) || {}).email || '';
  const known = sender ? await query(`SELECT u.id FROM users u LEFT JOIN user_email_settings s ON s.user_id=u.id
                                      WHERE lower(u.email)=lower($1) OR lower(s.email)=lower($1) LIMIT 1`, [sender]) : { rows: [] };
  const userId = known.rows[0] ? known.rows[0].id : null;
  const key = await threadKeyFor(company.id, subject, inReplyTo);
  const r = await query(`INSERT INTO email_messages (company_id, direction, status, from_addr, to_addrs, cc_addrs, subject, body_text, thread_key, message_id, in_reply_to, user_id, sent_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING id`,
    [company.id, userId ? 'out' : 'in', userId ? 'sent' : 'received', from, to, cc, subject, body, key, messageId || null, inReplyTo || null, userId]);
  return { id: r.rows[0].id, direction: userId ? 'out' : 'in' };
}

// ── Research cache ──────────────────────────────────────────────────────────
async function getResearch(companyId, maxAgeDays = 30) {
  await ensureSchema();
  const r = await query(`SELECT items, created_at FROM company_research WHERE company_id=$1 AND created_at > NOW() - make_interval(days => $2::int)`, [companyId, maxAgeDays]);
  return r.rows[0] ? { items: r.rows[0].items || [], createdAt: r.rows[0].created_at } : null;
}
async function saveResearch(companyId, items) {
  await ensureSchema();
  await query(`INSERT INTO company_research (company_id, items, created_at) VALUES ($1,$2,NOW())
               ON CONFLICT (company_id) DO UPDATE SET items=$2, created_at=NOW()`, [companyId, JSON.stringify(items || [])]);
}

module.exports = {
  ensureSchema, PROVIDERS, detectProvider, getSettings, saveSettings, removeSettings, smtpConfig, markVerified,
  companyAddress, companyByAlias, trackingDomain, normSubject, threadKeyFor, getMessage, saveDraft, markSent, markFailed,
  deleteDraft, listCompanyMessages, companyThreads, buildThreads, recordInbound, getResearch, saveResearch,
};

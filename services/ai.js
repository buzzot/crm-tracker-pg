'use strict';
// AI helpers (Anthropic Messages API). No SDK needed — Node's built-in fetch.
//
// Railway env:
//   ANTHROPIC_API_KEY   required to enable AI features
//   ANTHROPIC_MODEL     optional, defaults to claude-haiku-5-5 (fast, low cost)

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 45000;

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// Small in-memory cache so re-opening a page doesn't re-bill the same summary.
// Keyed by a fingerprint of the inputs; entries expire after 24h.
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
function cacheGet(k) { const e = cache.get(k); if (!e) return null; if (Date.now() - e.at > CACHE_TTL) { cache.delete(k); return null; } return e.value; }
function cacheSet(k, value) { if (cache.size > 500) cache.delete(cache.keys().next().value); cache.set(k, { at: Date.now(), value }); }

async function callClaude({ system, user, maxTokens = 900 }) {
  if (!isConfigured()) {
    const err = new Error('AI is not set up. Add ANTHROPIC_API_KEY in Railway settings.');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Never surface the key or raw provider payloads to the browser
      const msg = (data && data.error && data.error.type) || ('HTTP ' + res.status);
      const err = new Error('AI request failed (' + msg + ').');
      err.code = res.status === 401 ? 'AI_AUTH' : res.status === 429 ? 'AI_RATE' : 'AI_ERROR';
      throw err;
    }
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('AI took too long to respond. Try again.'); err.code = 'AI_TIMEOUT'; throw err; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Pull the first JSON object out of a model reply (tolerates code fences / stray text)
function parseJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}

function clip(s, n) { s = String(s || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(); return s.length > n ? s.slice(0, n) + ' …[truncated]' : s; }
function fmtWhen(d) { const t = new Date(d); return isNaN(t) ? '' : t.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }

function describeMessage(c) {
  const m = c.manual;
  let kind;
  if (m) kind = ({ email: 'Email', wechat: 'WeChat', other: 'Message' }[m.channel] || 'Message') + (m.direction === 'out' ? ' sent' : ' received');
  else kind = c.type === 'email' ? 'Email received' : 'Internal comment';
  const head = [`[${fmtWhen(c.postedAt)}] ${kind}`, `from: ${c.author || 'Unknown'}`];
  if (m && m.to) head.push(`to: ${m.to}`);
  if (c.emailSubject) head.push(`subject: ${c.emailSubject}`);
  const files = (c.attachments || []).map((a) => a.filename).filter(Boolean);
  return head.join(' | ') + (files.length ? `\nattachments: ${files.join(', ')}` : '') + '\n' + clip(c.comment, 3500);
}

const SYSTEM_THREAD = `You are an assistant inside a B2B CRM used by Samyou, a supplier of HVAC controllers and inverter drives.
You summarise a project's communication history (emails, WeChat messages, internal comments) for the sales and engineering team.
Messages may be in English or Chinese; always write the summary in English, keeping names, part numbers and figures exactly as written.
Be factual and concise. Only use information present in the messages; if something is unclear, say so rather than guessing.
Reply with ONLY a JSON object, no other text, in this shape:
{"summary":"2-4 sentence overview of where the project stands",
 "latest":"one sentence on the most recent exchange and who is waiting on whom",
 "action_items":[{"owner":"person or side responsible, or \\"Samyou\\"/\\"Customer\\"","item":"what needs to happen","due":"date if stated, else empty"}],
 "open_questions":["unresolved questions or risks"],
 "sentiment":"positive | neutral | concerned"}`;

async function summarizeThread({ project, comments, tasks }) {
  const ordered = (comments || []).slice().sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt));
  if (!ordered.length) { const e = new Error('There are no messages to summarise yet.'); e.code = 'AI_EMPTY'; throw e; }

  // Keep the newest messages when the thread is long (~60k chars budget)
  let budget = 60000; const picked = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const block = describeMessage(ordered[i]);
    if (budget - block.length < 0 && picked.length) break;
    budget -= block.length; picked.unshift(block);
  }
  const skipped = ordered.length - picked.length;
  const taskLines = (tasks || []).map((t) => `- ${t.name} [${t.status || 'To Do'}]${t.deadline ? ' due ' + t.deadline : ''}`).join('\n') || '- none';

  const key = 'thread:' + project.id + ':' + ordered.length + ':' + ordered.map((c) => c.id + '@' + new Date(c.postedAt).getTime() + ':' + String(c.comment || '').length).join(',').slice(-4000);
  const hit = cacheGet(key); if (hit) return { ...hit, cached: true };

  const user = `Project: ${project.name}
Company: ${(project.companies || []).map((c) => c.name).join(', ') || project.companyName || 'unknown'}
Status: ${project.status || 'unknown'}
Tasks:
${taskLines}

Messages (oldest first${skipped ? `; ${skipped} older message(s) omitted` : ''}):

${picked.join('\n\n---\n\n')}`;

  const text = await callClaude({ system: SYSTEM_THREAD, user, maxTokens: 1000 });
  const json = parseJson(text) || { summary: text, latest: '', action_items: [], open_questions: [], sentiment: 'neutral' };
  const value = {
    summary: String(json.summary || '').trim(),
    latest: String(json.latest || '').trim(),
    actionItems: (Array.isArray(json.action_items) ? json.action_items : []).slice(0, 10).map((a) => ({ owner: String(a.owner || '').trim(), item: String(a.item || '').trim(), due: String(a.due || '').trim() })).filter((a) => a.item),
    openQuestions: (Array.isArray(json.open_questions) ? json.open_questions : []).slice(0, 8).map((q) => String(q).trim()).filter(Boolean),
    sentiment: ['positive', 'neutral', 'concerned'].includes(json.sentiment) ? json.sentiment : 'neutral',
    messageCount: ordered.length,
    generatedAt: new Date().toISOString(),
  };
  cacheSet(key, value);
  return value;
}

const SYSTEM_ONE = `You summarise a single business email or chat message for a busy CRM user at Samyou (HVAC controllers and inverter drives).
The message may be in English or Chinese; write in English, keeping names, part numbers and figures exactly as written.
Reply with ONLY a JSON object: {"tldr":"one or two sentences","asks":["specific requests or questions addressed to the reader, if any"]}`;

async function summarizeMessage(c) {
  const key = 'msg:' + c.id + ':' + String(c.comment || '').length + ':' + (c.emailSubject || '');
  const hit = cacheGet(key); if (hit) return { ...hit, cached: true };
  const text = await callClaude({ system: SYSTEM_ONE, user: describeMessage(c), maxTokens: 400 });
  const json = parseJson(text) || { tldr: text, asks: [] };
  const value = {
    tldr: String(json.tldr || '').trim(),
    asks: (Array.isArray(json.asks) ? json.asks : []).slice(0, 6).map((x) => String(x).trim()).filter(Boolean),
  };
  cacheSet(key, value);
  return value;
}

module.exports = { isConfigured, summarizeThread, summarizeMessage, _parseJson: parseJson, _describeMessage: describeMessage };

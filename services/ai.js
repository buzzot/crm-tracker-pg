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

// Call Claude. With `tool`, the model is forced to answer through that tool, so the API
// returns an already-parsed object that matches the tool's JSON schema (no fragile
// JSON-in-text parsing). Without `tool`, returns plain text.
async function callClaude({ system, user, maxTokens = 900, tool = null, timeoutMs = TIMEOUT_MS, extraTools = null, toolChoiceAuto = false, model = null }) {
  if (!isConfigured()) {
    const err = new Error('AI is not set up. Add ANTHROPIC_API_KEY in Railway settings.');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model: model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],   // string or [image…, text] blocks
    };
    if (tool) {
      body.tools = [...(extraTools || []), tool];
      body.tool_choice = toolChoiceAuto ? { type: 'auto' } : { type: 'tool', name: tool.name };
    }
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Never surface the key or raw provider payloads to the browser
      const msg = (data && data.error && data.error.type) || ('HTTP ' + res.status);
      const err = new Error('AI request failed (' + msg + ').');
      err.code = res.status === 401 ? 'AI_AUTH' : res.status === 429 ? 'AI_RATE' : 'AI_ERROR';
      throw err;
    }
    if (data.stop_reason === 'max_tokens') {
      console.warn('[ai] reply hit max_tokens', { maxTokens, model: body.model });
      const err = new Error('The AI reply was cut off because the message is very long. Try again; if it keeps happening, use Original.');
      err.code = 'AI_TRUNCATED';
      throw err;
    }
    if (tool) {
      const use = (data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (use && use.input && typeof use.input === 'object') return use.input;
      // Fallback: some models may still answer in text
      const txt = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const parsed = parseJson(txt);
      if (parsed) return parsed;
      console.warn('[ai] no structured result', { stop: data.stop_reason, blocks: (data.content || []).map((b) => b.type) });
      const err = new Error("The AI couldn't produce a clean result for this message. Try again.");
      err.code = 'AI_BAD_OUTPUT';
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

// Retry once on transient problems (bad/truncated output, timeouts, rate limits)
async function callClaudeRetry(opts) {
  try { return await callClaude(opts); }
  catch (e) {
    if (!['AI_BAD_OUTPUT', 'AI_TIMEOUT', 'AI_RATE', 'AI_ERROR', 'AI_TRUNCATED'].includes(e.code)) throw e;
    const next = e.code === 'AI_TRUNCATED' ? { ...opts, maxTokens: Math.min(16000, (opts.maxTokens || 900) * 2) } : opts;
    if (e.code === 'AI_RATE') await new Promise((r) => setTimeout(r, 2000));
    return callClaude(next);
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
  const shots = (c.manual && c.manual.ai && Array.isArray(c.manual.ai.screenshots)) ? c.manual.ai.screenshots : [];
  const shotText = shots.map((x) => `\n[text read from screenshot ${x.filename || ''}]\n${clip(x.transcript, 2500)}`).join('');
  return head.join(' | ') + (files.length ? `\nattachments: ${files.join(', ')}` : '') + '\n' + clip(c.comment, 3500) + shotText;
}

// ── Images (screenshots) ─────────────────────────────────────────────────────
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 3.7 * 1024 * 1024;   // API limit is 5 MB per image after base64 encoding

function imageAttachments(c) {
  return (c.attachments || []).filter((a) => a && a.url && IMAGE_TYPES.has(String(a.contentType || '').toLowerCase()));
}

// Download images so they can be sent to Claude. Unreadable/oversized ones are listed, not fatal.
async function loadImages(c) {
  const list = imageAttachments(c);
  const images = [], skipped = [];
  for (const a of list.slice(0, MAX_IMAGES)) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(a.url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      if (!res.ok) { skipped.push(`${a.filename} (could not download)`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) { skipped.push(`${a.filename} (too large to read, over 3.7 MB)`); continue; }
      const type = (res.headers.get('content-type') || a.contentType || '').split(';')[0].trim().toLowerCase();
      images.push({ filename: a.filename, mediaType: IMAGE_TYPES.has(type) ? type : String(a.contentType).toLowerCase(), data: buf.toString('base64') });
    } catch (e) {
      skipped.push(`${a.filename} (could not download)`);
    }
  }
  if (list.length > MAX_IMAGES) skipped.push(`${list.length - MAX_IMAGES} more image(s) not read (limit ${MAX_IMAGES})`);
  return { images, skipped };
}

const SYSTEM_THREAD = `You are an assistant inside a B2B CRM used by Samyou, a supplier of HVAC controllers and inverter drives.
You summarise a project's communication history (emails, WeChat messages, internal comments) for the sales and engineering team.
Messages may be in English or Chinese; always write the summary in English, keeping names, part numbers and figures exactly as written.
Be factual and concise. Only use information present in the messages; if something is unclear, say so rather than guessing.
Return your answer with the submit_summary tool.`;

const THREAD_TOOL = {
  name: 'submit_summary',
  description: 'Submit the structured project conversation summary.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-4 sentence overview of where the project stands' },
      latest: { type: 'string', description: 'One sentence on the most recent exchange and who is waiting on whom' },
      action_items: { type: 'array', items: { type: 'object', properties: {
        owner: { type: 'string', description: 'Person or side responsible, e.g. a name, "Samyou" or "Customer"' },
        item: { type: 'string' }, due: { type: 'string', description: 'Date if stated, else empty' } }, required: ['item'] } },
      open_questions: { type: 'array', items: { type: 'string' } },
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'concerned'] },
    },
    required: ['summary', 'latest', 'action_items', 'open_questions', 'sentiment'],
  },
};

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

  const json = await callClaudeRetry({ system: SYSTEM_THREAD, user, maxTokens: 2000, tool: THREAD_TOOL });
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

const SYSTEM_FORMAT = `You turn one raw business email or chat message into a clean, easy-to-read version for a CRM at Samyou (HVAC controllers and inverter drives).
Rules:
- Keep ALL facts, numbers, part numbers, dates, names and requests. Never invent or change information.
- Write in English. If the message is in Chinese, translate it faithfully.
- Remove noise: repeated blank lines, email signatures, legal disclaimers, "sent from my phone", tracking lines. Keep the greeting and sign-off name short.
- If the text contains a table that was pasted as one cell per line (e.g. "Input", "Size", "Voltage" followed by values), rebuild it as a table.
- Use short paragraphs, bullet lists for enumerations, and headings only when the message has clear sections.
- If quoted earlier emails are included, keep only the newest message and add one paragraph "Earlier messages in the thread were quoted and omitted."
- Attached images are usually screenshots (WeChat or other chats, emails, spec sheets, drawings). Read them carefully:
  * Put their content into the clean blocks under a heading like "From screenshot" (one per image when there are several).
  * Chat screenshots: a list of "Name (time if visible): message", in order, translated to English.
  * Tables in images: rebuild as a table. Other documents: short paragraphs or a list.
  * If the typed text says only "(screenshot attached)", the screenshots ARE the message.
  * Also return the verbatim text of each image, in its original language, in "screenshots".
Return the result with the submit_clean_message tool.`;

const FORMAT_TOOL = {
  name: 'submit_clean_message',
  description: 'Submit the clean, structured reading version of the message.',
  input_schema: {
    type: 'object',
    properties: {
      tldr: { type: 'string', description: 'One or two sentences: what the message is about and what it wants' },
      asks: { type: 'array', items: { type: 'string' }, description: 'Concrete requests or questions addressed to the reader' },
      blocks: {
        type: 'array',
        description: 'The message body as ordered blocks',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['p', 'h', 'ul', 'table'] },
            text: { type: 'string', description: 'For p and h blocks' },
            items: { type: 'array', items: { type: 'string' }, description: 'For ul blocks' },
            headers: { type: 'array', items: { type: 'string' }, description: 'For table blocks' },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'For table blocks' },
          },
          required: ['type'],
        },
      },
      screenshots: {
        type: 'array',
        description: 'One entry per attached image, in order',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            kind: { type: 'string', enum: ['chat', 'email', 'document', 'table', 'photo', 'other'] },
            transcript: { type: 'string', description: 'All readable text, verbatim, in the original language (chat lines as "Name: message")' },
          },
          required: ['transcript'],
        },
      },
    },
    required: ['tldr', 'asks', 'blocks'],
  },
};

function cleanBlocks(blocks) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks.slice(0, 80) : []) {
    if (!b || typeof b !== 'object') continue;
    const str = (v) => String(v == null ? '' : v).trim().slice(0, 4000);
    if ((b.type === 'p' || b.type === 'h') && str(b.text)) out.push({ type: b.type, text: str(b.text) });
    else if (b.type === 'ul' && Array.isArray(b.items)) {
      const items = b.items.map(str).filter(Boolean).slice(0, 50);
      if (items.length) out.push({ type: 'ul', items });
    } else if (b.type === 'table' && Array.isArray(b.rows)) {
      const headers = (Array.isArray(b.headers) ? b.headers : []).map(str).slice(0, 12);
      const rows = b.rows.filter(Array.isArray).slice(0, 60).map((r) => r.map(str).slice(0, 12));
      if (rows.length) out.push({ type: 'table', headers, rows });
    }
  }
  return out;
}

// Clean, structured reading version of one message (+ TL;DR). Result is stored on the comment.
async function formatMessage(c) {
  const imgs = imageAttachments(c);
  const key = 'fmt:' + c.id + ':' + String(c.comment || '').length + ':' + (c.emailSubject || '') + ':' + imgs.map((a) => a.id || a.url).join(',');
  const hit = cacheGet(key); if (hit) return { ...hit, cached: true };
  const raw = String(c.comment || '').replace(/\r/g, '');
  const { images, skipped } = imgs.length ? await loadImages(c) : { images: [], skipped: [] };
  let text = describeMessage({ ...c, manual: c.manual ? { ...c.manual, ai: null } : null, comment: raw.length > 14000 ? raw.slice(0, 14000) + ' …[truncated]' : raw });
  if (images.length) text += `\n\n${images.length} screenshot(s) attached below, in order: ${images.map((i) => i.filename).join(', ')}.`;
  if (skipped.length) text += `\nNot readable: ${skipped.join('; ')}.`;
  const content = images.length
    ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text }]
    : text;

  // Output is roughly the size of the input (+ screenshot text); allow generous room
  const maxTokens = Math.min(16000, Math.max(3000, Math.ceil(raw.length / 2.5) + 1500 + images.length * 1500));
  const json = await callClaudeRetry({ system: SYSTEM_FORMAT, user: content, maxTokens, tool: FORMAT_TOOL, timeoutMs: 120000 });
  const value = {
    tldr: String(json.tldr || '').trim().slice(0, 600),
    asks: (Array.isArray(json.asks) ? json.asks : []).slice(0, 8).map((x) => String(x).trim()).filter(Boolean),
    blocks: cleanBlocks(json.blocks),
    screenshots: (Array.isArray(json.screenshots) ? json.screenshots : []).slice(0, MAX_IMAGES).map((x, i) => ({
      filename: String((x && x.filename) || (images[i] && images[i].filename) || `image ${i + 1}`).slice(0, 200),
      kind: String((x && x.kind) || 'other'),
      transcript: String((x && x.transcript) || '').trim().slice(0, 8000),
    })).filter((x) => x.transcript),
    imagesRead: images.length,
    imagesSkipped: skipped,
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    at: new Date().toISOString(),
  };
  if (!value.blocks.length && !value.tldr) { const e = new Error("The AI couldn't produce a clean result for this message. Try again."); e.code = 'AI_BAD_OUTPUT'; throw e; }
  cacheSet(key, value);
  return value;
}

// ── Preview before saving: read screenshots that haven't been uploaded yet ────
// images: [{ filename, mimetype, buffer }] from multer. Returns the clean result plus
// a plain formatted text version the user can review/edit and save as the message.
async function readImages(files, { text = '', channel = 'comment', direction = 'in', from = '' } = {}) {
  const usable = [], skipped = [];
  for (const f of (files || []).slice(0, MAX_IMAGES)) {
    const type = String(f.mimetype || '').toLowerCase();
    if (!IMAGE_TYPES.has(type)) { skipped.push(`${f.originalname} (not an image)`); continue; }
    if (f.size > MAX_IMAGE_BYTES) { skipped.push(`${f.originalname} (too large to read, over 3.7 MB)`); continue; }
    usable.push({ filename: f.originalname, mediaType: type, data: f.buffer.toString('base64') });
  }
  if ((files || []).length > MAX_IMAGES) skipped.push(`${files.length - MAX_IMAGES} more image(s) not read (limit ${MAX_IMAGES})`);
  if (!usable.length) { const e = new Error('No readable screenshots (PNG, JPG, GIF or WebP under 3.7 MB).'); e.code = 'AI_NO_IMAGES'; throw e; }

  const kind = channel === 'comment' ? 'Internal comment' : ({ email: 'Email', wechat: 'WeChat', other: 'Message' }[channel] || 'Message') + (direction === 'out' ? ' sent' : ' received');
  let prompt = `${kind}${from ? ' | from: ' + from : ''}\nTyped text: ${clip(text, 6000) || '(none — the screenshots are the message)'}\n\n${usable.length} screenshot(s) attached below, in order: ${usable.map((i) => i.filename).join(', ')}.`;
  if (skipped.length) prompt += `\nNot readable: ${skipped.join('; ')}.`;
  prompt += '\nFocus on the screenshot content. Do not repeat the typed text in the blocks; describe only what the screenshots contain.';
  const content = [...usable.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: prompt }];

  const json = await callClaudeRetry({ system: SYSTEM_FORMAT, user: content, maxTokens: Math.min(16000, 2500 + usable.length * 2000), tool: FORMAT_TOOL, timeoutMs: 120000 });
  const value = {
    tldr: String(json.tldr || '').trim().slice(0, 600),
    asks: (Array.isArray(json.asks) ? json.asks : []).slice(0, 8).map((x) => String(x).trim()).filter(Boolean),
    blocks: cleanBlocks(json.blocks),
    screenshots: (Array.isArray(json.screenshots) ? json.screenshots : []).slice(0, MAX_IMAGES).map((x, i) => ({
      filename: String((x && x.filename) || (usable[i] && usable[i].filename) || `image ${i + 1}`).slice(0, 200),
      kind: String((x && x.kind) || 'other'),
      transcript: String((x && x.transcript) || '').trim().slice(0, 8000),
    })).filter((x) => x.transcript),
    imagesRead: usable.length,
    imagesSkipped: skipped,
  };
  value.text = blocksToText(value);
  value.hasForeignText = value.screenshots.some((x) => /[　-鿿가-힯]/.test(x.transcript));
  return value;
}

// Blocks → readable plain text (what gets saved as the message body)
function blocksToText(v) {
  const out = [];
  for (const b of v.blocks || []) {
    if (b.type === 'h') out.push(b.text.toUpperCase() === b.text ? b.text : b.text + ':');
    else if (b.type === 'p') out.push(b.text);
    else if (b.type === 'ul') out.push(b.items.map((x) => '• ' + x).join('\n'));
    else if (b.type === 'table') {
      const rows = [b.headers && b.headers.length ? b.headers : null, ...b.rows].filter(Boolean);
      const widths = [];
      rows.forEach((r) => r.forEach((cell, i) => { widths[i] = Math.min(28, Math.max(widths[i] || 0, String(cell).length)); }));
      const line = (r) => r.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ').trimEnd();
      const t = rows.map(line);
      if (b.headers && b.headers.length) t.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('-|-'));
      out.push(t.join('\n'));
    }
  }
  return out.join('\n\n').trim();
}

// ── Company research (web search) for first-contact emails ──────────────────
const RESEARCH_TOOL = {
  name: 'submit_research',
  description: 'Submit the research findings.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '3 to 6 recent, relevant findings',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'One-line finding, factual' },
            detail: { type: 'string', description: 'Why it matters for a supplier of HVAC inverter drives and controllers (1 sentence)' },
            source: { type: 'string', description: 'Publication or site name' },
            url: { type: 'string' },
            date: { type: 'string', description: 'Approximate date, e.g. "Sep 2026"' },
          },
          required: ['title', 'source'],
        },
      },
    },
    required: ['items'],
  },
};

async function researchCompany(company) {
  const system = `You research a B2B prospect for Samyou, a supplier of inverter drives (VFD), controllers and electronics for HVAC/refrigeration equipment makers.
Use web search to find RECENT (last 12–18 months) and relevant facts: new products or platforms, plant expansions, efficiency/refrigerant regulation impact, acquisitions, leadership changes, supplier/localisation moves, financial results.
Only include facts you found in sources; include the URL. Then call submit_research.`;
  const user = `Company: ${company.name}${company.web ? ' (' + company.web + ')' : ''}${company.industry ? ', industry: ' + company.industry : ''}${company.billingAddress ? ', located: ' + company.billingAddress : ''}.`;
  const json = await callClaudeRetry({
    system, user, maxTokens: 3000, tool: RESEARCH_TOOL, toolChoiceAuto: true, timeoutMs: 120000,
    extraTools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
    model: process.env.ANTHROPIC_RESEARCH_MODEL || null,
  });
  return (Array.isArray(json.items) ? json.items : []).slice(0, 6).map((x, i) => ({
    id: i + 1,
    title: String(x.title || '').trim().slice(0, 300),
    detail: String(x.detail || '').trim().slice(0, 400),
    source: String(x.source || '').trim().slice(0, 120),
    url: /^https?:\/\//.test(String(x.url || '')) ? String(x.url).slice(0, 500) : '',
    date: String(x.date || '').trim().slice(0, 40),
  })).filter((x) => x.title);
}

// ── Email drafting ──────────────────────────────────────────────────────────
const DRAFT_TOOL = {
  name: 'submit_draft',
  description: 'Submit the email draft.',
  input_schema: {
    type: 'object',
    properties: {
      stage: { type: 'string', enum: ['first_contact', 'follow_up', 'reply', 're_engage', 'ongoing'] },
      stage_reason: { type: 'string', description: 'One short sentence explaining the stage' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Plain-text email body. Greeting, short paragraphs, sign-off with the sender first name only (the signature is added automatically).' },
      gaps: { type: 'array', items: { type: 'string' }, description: 'Facts you needed but did not have; they appear in the body as [square brackets]' },
      used_research: { type: 'array', items: { type: 'integer' }, description: 'ids of research items mentioned' },
    },
    required: ['stage', 'subject', 'body'],
  },
};

const GOALS = {
  introduce: 'Introduce Samyou and open a conversation',
  meeting: 'Ask for a short call or meeting',
  quote: 'Send or discuss a quotation',
  follow_up: 'Follow up on the last exchange',
  re_engage: 'Re-engage after a period of silence',
  answer: 'Answer their latest questions',
  custom: 'Follow the user instructions',
};

async function draftEmail(ctx) {
  const system = `You write business emails for ${ctx.sender.name || 'a salesperson'} at Samyou (inverter drives, controllers and electronics for HVAC/refrigeration OEMs; offices in the USA and China).
Write like an experienced, friendly B2B account manager: specific, short (80–180 words unless replying to many questions), no hype, no clichés ("I hope this email finds you well"), one clear call to action.
Use ONLY facts from the CRM context, the user's instructions and the selected research. Never invent prices, lead times, certifications, dates or customer names: if one is needed, write it as [square brackets] and list it in gaps.
When research items are provided, mention at most two naturally and accurately.
Decide the conversation stage from the history: first_contact (no prior emails with this person/company), reply (their message is the latest and expects an answer), follow_up (we wrote last and are waiting), re_engage (no exchange for 60+ days), ongoing.
Language: ${ctx.language === 'zh' ? 'Simplified Chinese (keep product names and part numbers as written)' : 'English'}. Tone: ${ctx.tone || 'professional and warm'}.
Return the result with the submit_draft tool.`;

  const hist = (ctx.history || []).slice(-12).map((m) =>
    `[${new Date(m.sentAt || m.createdAt).toISOString().slice(0, 10)}] ${m.direction === 'in' ? 'THEM' : 'US'} | from: ${m.from} | to: ${m.to}\nSubject: ${m.subject}\n${clip(m.body, 1500)}`).join('\n\n---\n\n');
  const research = (ctx.research || []).map((r) => `#${r.id} ${r.title}${r.detail ? ' — ' + r.detail : ''} (${r.source}${r.date ? ', ' + r.date : ''})`).join('\n');
  const user = `GOAL: ${GOALS[ctx.goal] || GOALS.introduce}
USER INSTRUCTIONS: ${ctx.instructions ? clip(ctx.instructions, 2000) : '(none)'}
${ctx.currentDraft ? 'CURRENT DRAFT TO REVISE:\n' + clip(ctx.currentDraft, 4000) + '\n' : ''}
SENDER: ${ctx.sender.name} <${ctx.sender.email}>${ctx.sender.title ? ', ' + ctx.sender.title : ''}
RECIPIENTS: ${(ctx.recipients || []).map((r) => `${r.name || ''} <${r.email}>${r.title ? ' (' + r.title + ')' : ''}`).join('; ') || '(not chosen yet)'}
COMPANY: ${ctx.company.name}${ctx.company.industry ? ' | industry: ' + ctx.company.industry : ''}${ctx.company.status ? ' | status: ' + ctx.company.status : ''}${ctx.company.web ? ' | ' + ctx.company.web : ''}
OPEN DEALS: ${(ctx.deals || []).map((d) => `${d.name} [${d.stage}${d.amountSet !== false && d.amount ? ', $' + d.amount : ''}]`).join('; ') || 'none'}
PROJECTS: ${(ctx.projects || []).map((p) => `${p.name} [${p.status || 'no status'}]${(p.products || []).length ? ' products: ' + p.products.map((x) => x.name).join(', ') : ''}`).join('; ') || 'none'}
RECENT ACTIVITY: ${(ctx.activities || []).slice(0, 6).map((a) => `${a.statusDate || a.date || ''} ${a.type || ''}: ${a.name}${a.result ? ' (' + a.result + ')' : ''}`).join('; ') || 'none'}
${ctx.replyTo ? 'REPLYING TO THIS THREAD (latest last).\n' : ''}EMAIL HISTORY (oldest first):
${hist || '(no previous emails)'}
${research ? '\nSELECTED RESEARCH:\n' + research : ''}`;

  const json = await callClaudeRetry({ system, user, maxTokens: 2000, tool: DRAFT_TOOL, timeoutMs: 90000 });
  return {
    stage: String(json.stage || 'ongoing'),
    stageReason: String(json.stage_reason || '').trim().slice(0, 300),
    subject: String(json.subject || '').trim().slice(0, 300),
    body: String(json.body || '').replace(/\r/g, '').trim().slice(0, 12000),
    gaps: (Array.isArray(json.gaps) ? json.gaps : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10),
    usedResearch: (Array.isArray(json.used_research) ? json.used_research : []).map(Number).filter(Number.isFinite),
  };
}

// Back-compat: short TL;DR only
async function summarizeMessage(c) { const f = await formatMessage(c); return { tldr: f.tldr, asks: f.asks }; }

module.exports = { isConfigured, summarizeThread, summarizeMessage, formatMessage, imageAttachments, readImages, blocksToText, researchCompany, draftEmail, _parseJson: parseJson, _describeMessage: describeMessage };

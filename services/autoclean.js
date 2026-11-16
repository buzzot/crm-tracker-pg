'use strict';
// Background AI clean-up of long external messages (emails / WeChat / logged).
// Fire-and-forget: never blocks or fails the request that saved the message.
const crm = require('./crm');
const ai = require('./ai');

const MIN_LENGTH = 300;   // short messages are already easy to read

function isExternal(c) { return !!(c && (c.manual || c.type === 'email')); }

async function cleanNow(commentId) {
  const c = await crm.getComment(commentId);
  if (!c) throw new Error('Message not found.');
  if (!isExternal(c)) { const e = new Error('Only emails and logged messages can be cleaned up.'); e.code = 'NOT_EXTERNAL'; throw e; }
  const result = await ai.formatMessage(c);
  await crm.setCommentAi(c.id, result);
  return result;
}

function autoClean(commentId) {
  if (!commentId || !ai.isConfigured()) return;
  setImmediate(async () => {
    try {
      const c = await crm.getComment(commentId);
      if (!isExternal(c) || String(c.comment || '').length < MIN_LENGTH) return;
      const result = await ai.formatMessage(c);
      await crm.setCommentAi(c.id, result);
    } catch (err) {
      console.error('[autoclean] skipped', commentId, '-', err.code || '', err.message);
    }
  });
}

module.exports = { autoClean, cleanNow, isExternal, MIN_LENGTH };

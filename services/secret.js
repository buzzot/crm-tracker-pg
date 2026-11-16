'use strict';
// AES-256-GCM encryption for stored mailbox passwords.
// Key: EMAIL_SECRET if set, otherwise derived from SESSION_SECRET.
// If the secret changes, saved passwords can no longer be read and users re-enter them.
const crypto = require('crypto');

function key() {
  const base = process.env.EMAIL_SECRET || process.env.SESSION_SECRET;
  if (!base) throw new Error('Server is missing SESSION_SECRET / EMAIL_SECRET.');
  return crypto.createHash('sha256').update('crm-mailbox:' + base).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(blob) {
  const [v, iv, tag, data] = String(blob || '').split(':');
  if (v !== 'v1') throw new Error('Unknown secret format.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };

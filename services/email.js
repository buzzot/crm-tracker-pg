'use strict';

/**
 * Outbound email via Mailgun REST API (no npm package needed).
 *
 * Required env vars:
 *   MAILGUN_API_KEY   – your Mailgun private API key (key-…)
 *   MAILGUN_DOMAIN    – your sending domain (e.g. mg.samyou.com)
 *   APP_URL           – public base URL of this app (e.g. https://crm.samyou.com)
 *                       Falls back to http://localhost:PORT
 */

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN  = process.env.MAILGUN_DOMAIN  || '';
const APP_URL         = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

// Samyou logo — public Supabase URL or a fallback inline SVG data URI.
// Set LOGO_URL env var to override with your own hosted logo.
const LOGO_URL = process.env.LOGO_URL || '';

/**
 * Low-level: POST form data to Mailgun.
 */
async function _mailgunPost(path, params) {
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.warn('[email] MAILGUN_API_KEY or MAILGUN_DOMAIN not set — email not sent.');
    return;
  }

  const body = new URLSearchParams(params).toString();
  const auth  = Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');

  const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mailgun error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Build the invitation email HTML.
 */
function _buildInviteHtml({ name, email, loginUrl, tempPassword }) {
  const logoHtml = LOGO_URL
    ? `<img src="${LOGO_URL}" alt="Samyou" style="height:40px; width:auto; margin-bottom:24px;">`
    : `<div style="font-size:22px; font-weight:700; color:#1a1a2e; margin-bottom:24px; letter-spacing:-0.5px;">Samyou</div>`;

  const greeting = name ? `Hi ${name},` : 'Hi,';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're invited to Samyou CRM</title>
</head>
<body style="margin:0; padding:0; background:#f4f6fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb; padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#ffffff; border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,0.08); overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#1a1a2e; padding:32px 40px; text-align:center;">
              ${logoHtml}
              <div style="font-size:13px; color:rgba(255,255,255,0.55); letter-spacing:0.5px; text-transform:uppercase;">CRM Platform</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 28px;">
              <p style="margin:0 0 8px; font-size:22px; font-weight:700; color:#1a1a2e; line-height:1.3;">${greeting}</p>
              <p style="margin:0 0 20px; font-size:15px; color:#444; line-height:1.6;">
                You've been invited to <strong>Samyou CRM</strong> — your team's platform for effective collaboration on clients, projects, and deals.
              </p>

              <!-- Credentials box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fc; border:1px solid #e5e8ef; border-radius:8px; margin-bottom:24px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <div style="font-size:11px; font-weight:600; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px;">Your login details</div>
                    <div style="margin-bottom:8px;">
                      <span style="font-size:12px; color:#888; display:block; margin-bottom:2px;">Email</span>
                      <span style="font-size:14px; font-weight:600; color:#1a1a2e;">${email}</span>
                    </div>
                    <div>
                      <span style="font-size:12px; color:#888; display:block; margin-bottom:2px;">Temporary password</span>
                      <span style="font-size:14px; font-weight:600; color:#1a1a2e; font-family:monospace; letter-spacing:0.5px;">${tempPassword}</span>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- CTA button -->
              <div style="text-align:center; margin-bottom:24px;">
                <a href="${loginUrl}"
                   style="display:inline-block; background:#3b5bdb; color:#ffffff; text-decoration:none;
                          font-size:15px; font-weight:600; padding:14px 32px; border-radius:8px;
                          letter-spacing:0.2px;">
                  Log in to Samyou CRM →
                </a>
              </div>

              <p style="margin:0; font-size:13px; color:#888; line-height:1.6;">
                After logging in, you'll be prompted to set a new password. Keep your account secure — don't share your credentials.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fc; border-top:1px solid #e5e8ef; padding:20px 40px; text-align:center;">
              <p style="margin:0; font-size:12px; color:#aaa; line-height:1.6;">
                This invitation was sent by your Samyou CRM administrator.<br>
                If you weren't expecting this email, you can safely ignore it.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Send a new-user invitation email.
 *
 * @param {object} opts
 * @param {string} opts.to           – recipient email address
 * @param {string} opts.name         – recipient display name
 * @param {string} opts.tempPassword – plaintext temporary password (to show in email)
 */
async function sendInviteEmail({ to, name, tempPassword }) {
  const loginUrl = `${APP_URL}/login`;
  const html     = _buildInviteHtml({ name, email: to, loginUrl, tempPassword });
  const text     = [
    `Hi ${name || 'there'},`,
    '',
    "You've been invited to Samyou CRM for effective collaboration.",
    '',
    'Your login details:',
    `  Email:              ${to}`,
    `  Temporary password: ${tempPassword}`,
    '',
    `Log in at: ${loginUrl}`,
    '',
    "You'll be prompted to set a new password after logging in.",
  ].join('\n');

  await _mailgunPost('messages', {
    from:    `Samyou CRM <no-reply@${MAILGUN_DOMAIN}>`,
    to,
    subject: "You're invited to Samyou CRM",
    html,
    text,
  });

  console.log(`[email] Invitation sent to ${to}`);
}

module.exports = { sendInviteEmail };

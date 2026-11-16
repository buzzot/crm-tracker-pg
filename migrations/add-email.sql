-- Email: per-user mailbox settings, company tracking addresses, email log, research cache.
-- The app also creates these automatically on first use (services/mail.js → ensureSchema).

CREATE TABLE IF NOT EXISTS user_email_settings (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  display_name   TEXT,
  provider       TEXT,
  smtp_host      TEXT NOT NULL,
  smtp_port      INT  NOT NULL,
  smtp_secure    TEXT NOT NULL DEFAULT 'ssl',      -- 'ssl' | 'starttls'
  smtp_user      TEXT NOT NULL,
  smtp_pass_enc  TEXT NOT NULL,                    -- AES-256-GCM, see services/secret.js
  signature      TEXT,
  verified_at    TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS inbox_alias TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_inbox_alias ON companies (lower(inbox_alias));

CREATE TABLE IF NOT EXISTS email_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID REFERENCES companies(id) ON DELETE CASCADE,
  project_id   UUID REFERENCES projects(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL,                    -- 'out' | 'in'
  status       TEXT NOT NULL DEFAULT 'sent',     -- 'draft' | 'sent' | 'failed' | 'received'
  from_addr    TEXT,
  to_addrs     TEXT,
  cc_addrs     TEXT,
  subject      TEXT,
  body_text    TEXT,
  thread_key   TEXT,
  message_id   TEXT,
  in_reply_to  TEXT,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  error        TEXT,
  ai           JSONB,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_messages_company ON email_messages (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread  ON email_messages (thread_key);
CREATE INDEX IF NOT EXISTS idx_email_messages_msgid   ON email_messages (message_id);

CREATE TABLE IF NOT EXISTS company_research (
  company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  items       JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sending method: 'mailgun' (HTTPS API; works on hosts that block SMTP) or 'smtp' (own mailbox)
ALTER TABLE user_email_settings ADD COLUMN IF NOT EXISTS send_method TEXT NOT NULL DEFAULT 'smtp';
ALTER TABLE user_email_settings ADD COLUMN IF NOT EXISTS bcc_self BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_email_settings ALTER COLUMN smtp_host DROP NOT NULL;
ALTER TABLE user_email_settings ALTER COLUMN smtp_port DROP NOT NULL;
ALTER TABLE user_email_settings ALTER COLUMN smtp_user DROP NOT NULL;
ALTER TABLE user_email_settings ALTER COLUMN smtp_pass_enc DROP NOT NULL;

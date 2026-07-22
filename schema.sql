-- =============================================================
-- CRM Tracker — PostgreSQL Schema
-- Run this in your Supabase SQL editor (or psql) to set up.
-- =============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---- Users & Auth ----------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'Sales',   -- 'Admin' | 'Manager' | 'Sales'
  password_hash TEXT NOT NULL,
  avatar_url  TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Groups / Teams --------------------------------------

CREATE TABLE IF NOT EXISTS groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

-- ---- Companies -------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  industry        TEXT,
  status          TEXT,
  website         TEXT,
  billing_address TEXT,
  notes           TEXT,
  logo_url        TEXT,
  owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id        UUID REFERENCES groups(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Contacts --------------------------------------------

CREATE TABLE IF NOT EXISTS contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  title       TEXT,
  notes       TEXT,
  company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id    UUID REFERENCES groups(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Activities (CRM: calls, emails, meetings, etc.) ----

CREATE TABLE IF NOT EXISTS activities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT,               -- 'Call' | 'Email' | 'LinkedIn' | 'Meeting' | 'Demo'
  date        DATE,
  due_date    DATE,
  status_date DATE,
  result      TEXT,
  details     TEXT,
  regarding   TIMESTAMPTZ,
  company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id    UUID REFERENCES groups(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Many-to-many: activities ↔ contacts (attendees)
CREATE TABLE IF NOT EXISTS activity_contacts (
  activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, contact_id)
);

-- Many-to-many: activities ↔ projects
CREATE TABLE IF NOT EXISTS activity_projects (
  activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL,  -- FK added after projects table created
  PRIMARY KEY (activity_id, project_id)
);

-- ---- Deals -----------------------------------------------

CREATE TABLE IF NOT EXISTS deals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  stage       TEXT,
  amount      NUMERIC(14,2) DEFAULT 0,
  company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id    UUID REFERENCES groups(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Projects --------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  status      TEXT,
  details     TEXT,
  company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  deal_id     UUID REFERENCES deals(id) ON DELETE SET NULL,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id    UUID REFERENCES groups(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add deferred FK from activity_projects now that projects exists
ALTER TABLE activity_projects
  ADD CONSTRAINT fk_activity_projects_project
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- ---- Tasks (Project Activities) -------------------------

CREATE TABLE IF NOT EXISTS tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT,
  date        DATE,
  deadline    DATE,
  status      TEXT NOT NULL DEFAULT 'To Do',
  details     TEXT,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Many-to-many: tasks ↔ users (assignees)
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

-- ---- Products --------------------------------------------

CREATE TABLE IF NOT EXISTS products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  notes             TEXT,
  category          TEXT,
  phase             TEXT,
  input_voltage     TEXT,
  board_size        TEXT,
  horse_power       TEXT,
  max_input_power   TEXT,
  max_input_current TEXT,
  max_output_current TEXT,
  image_url         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Many-to-many: products ↔ projects
CREATE TABLE IF NOT EXISTS product_projects (
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, project_id)
);

-- ---- Comments (unified, polymorphic) --------------------
-- entity_type: 'activity' | 'task' | 'project' | 'deal' | 'contact'

CREATE TABLE IF NOT EXISTS comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT,
  author_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name   TEXT,               -- for webhook / email authors without accounts
  type          TEXT NOT NULL DEFAULT 'comment',  -- 'comment' | 'email'
  email_subject TEXT,
  link          TEXT,
  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entity_type, entity_id);

-- ---- Attachments -----------------------------------------

CREATE TABLE IF NOT EXISTS attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     TEXT NOT NULL,
  content_type TEXT,
  storage_path TEXT NOT NULL,     -- Supabase Storage bucket path
  public_url   TEXT,
  size_bytes   BIGINT,
  entity_type  TEXT NOT NULL,
  entity_id    UUID NOT NULL,
  uploaded_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);

-- ---- Task activity log -----------------------------------
-- Lightweight update log on tasks (replaces Airtable "Project Activity Records")

CREATE TABLE IF NOT EXISTS task_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name         TEXT,
  details      TEXT,
  category     TEXT,
  logged_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  logged_by_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- Access-control helper views
-- These views filter records based on the calling user's group(s).
-- Application passes user_id via SET LOCAL app.current_user_id.
-- ================================================================

-- Utility: get current user's group IDs
CREATE OR REPLACE FUNCTION current_user_groups()
RETURNS SETOF UUID LANGUAGE sql STABLE AS $$
  SELECT group_id FROM group_members
  WHERE user_id = current_setting('app.current_user_id', true)::uuid
$$;

-- Utility: is current user an Admin?
CREATE OR REPLACE FUNCTION current_user_is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = current_setting('app.current_user_id', true)::uuid
      AND role = 'Admin'
  )
$$;

-- ================================================================
-- Row-Level Security (enable after confirming app works)
-- Uncomment these blocks to enforce RLS at the DB level.
-- ================================================================

-- ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY companies_access ON companies FOR ALL USING (
--   current_user_is_admin()
--   OR owner_id = current_setting('app.current_user_id', true)::uuid
--   OR group_id IN (SELECT current_user_groups())
-- );

-- (Repeat pattern for contacts, activities, deals, projects, tasks)

-- ================================================================
-- Seed: first admin user — change password after first login!
-- Password below hashes to: Admin1234
-- ================================================================

INSERT INTO users (email, name, role, password_hash)
VALUES (
  'admin@example.com',
  'Admin',
  'Admin',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'  -- Admin1234
)
ON CONFLICT (email) DO NOTHING;

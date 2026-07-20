-- ============================================================
-- Migration: User enhancements + audit columns + assignments
-- Run this in Supabase SQL Editor (or psql).
-- Safe to run multiple times — uses IF NOT EXISTS / DO blocks.
-- ============================================================

-- 1. Add phone and title to users --------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT;

-- 2. Rename 'Sales' role to 'Staff' on existing rows ------------
UPDATE users SET role = 'Staff' WHERE role = 'Sales';

-- 3. Add created_by / updated_by to all CRM tables --------------

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 4. user_assignments — explicit access grants ------------------
-- When a Manager/Admin assigns any user to a project, deal, or activity,
-- that user gains full read+write access to that specific record.

CREATE TABLE IF NOT EXISTS user_assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,   -- 'project' | 'deal' | 'activity'
  entity_id    UUID NOT NULL,
  assigned_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_user_assignments_user    ON user_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_assignments_entity  ON user_assignments(entity_type, entity_id);

-- Done.

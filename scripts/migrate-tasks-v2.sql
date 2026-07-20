-- ============================================================
-- Migration: Task enhancements
-- Adds: start_date (auto), auditor_id, deadline change history
-- Run in Supabase SQL Editor (or psql). Safe to re-run.
-- ============================================================

-- 1. start_date — auto-set at creation, never changes after that
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS start_date DATE NOT NULL DEFAULT CURRENT_DATE;

-- 2. auditor_id — manager/admin who oversees the task
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS auditor_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- 3. Deadline change history --------------------------------
-- Every time deadline is updated a row is inserted here.

CREATE TABLE IF NOT EXISTS task_deadline_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_deadline   DATE,
  new_deadline   DATE,
  reason         TEXT,
  changed_by_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_by_name TEXT,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_deadline_history_task ON task_deadline_history(task_id);

-- Done.

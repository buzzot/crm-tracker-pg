-- Soft-archive for tasks (Admin-only, hidden from all other views)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS is_archived  BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by  UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_is_archived ON tasks(is_archived);

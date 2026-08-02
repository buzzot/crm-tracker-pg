-- Add missing project columns (category, dates, audit trail)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS category    TEXT,
  ADD COLUMN IF NOT EXISTS start_date  DATE,
  ADD COLUMN IF NOT EXISTS end_date    DATE,
  ADD COLUMN IF NOT EXISTS created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by  UUID REFERENCES users(id) ON DELETE SET NULL;

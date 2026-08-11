-- Add is_onboarding flag to tasks
-- Run once in Supabase SQL editor

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS is_onboarding BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tasks_is_onboarding ON tasks(is_onboarding) WHERE is_onboarding = TRUE;

-- Mark existing onboarding tasks by their emoji-prefixed names
-- (only needed if you already have onboarding tasks in the DB)
UPDATE tasks
SET is_onboarding = TRUE
WHERE project_id IS NULL
  AND name ~ '^(👋|🏠|🏢|👤|💰|📁|✅|📞|🔍|📦)';

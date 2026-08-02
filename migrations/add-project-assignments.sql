-- Project ownership: auditor + explicit assignees
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS auditor_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS project_assignees (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_assignees_project ON project_assignees(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assignees_user    ON project_assignees(user_id);

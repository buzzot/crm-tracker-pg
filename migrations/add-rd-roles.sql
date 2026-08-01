-- R&D issue flag on projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_rd_issue BOOLEAN NOT NULL DEFAULT FALSE;

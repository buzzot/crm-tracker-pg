-- Add status column to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Active';

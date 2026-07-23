-- Migration: user profile fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT;
-- avatar_url already exists in schema

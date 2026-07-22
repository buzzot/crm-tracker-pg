-- Migration: add notes column to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;

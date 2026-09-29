-- Add staff who may sign in to the portals. Emails must match your Cloudflare Access login.
-- Run with:  npx wrangler d1 execute delivermymedications --remote --file scripts/add-staff.sql
-- Roles: provider (reviews and signs), pharmacist (verifies and ships), technician (enters Rx, packs, ships; can't verify), admin (everything).
INSERT OR REPLACE INTO staff (email, name, role, npi, states) VALUES
  ('yaakov@safer.health', 'Yaakov Mavashev', 'admin', NULL, NULL);
-- Example provider (use the exact name for prescriptions, their NPI, and license states):
-- INSERT OR REPLACE INTO staff (email, name, role, npi, states) VALUES
--   ('dr.smith@example.com', 'Jane Smith, MD', 'provider', '1234567890', '["NY","NJ","CT","FL"]');

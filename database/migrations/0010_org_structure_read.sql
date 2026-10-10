-- 0010_org_structure_read
-- Owner: app_migrator
-- Milestone 1 / Phase 1D: Register org.structure.read permission (doc 10 row 15)

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('org.structure.read', 'NORMAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

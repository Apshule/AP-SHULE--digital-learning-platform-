-- Education portal capabilities are intentionally narrow: students are read-only,
-- and teachers can only write attendance/marks after assignment checks in the Worker.
INSERT OR IGNORE INTO role_capabilities (role, sector, capability, scope) VALUES
  ('student', 'education', 'records.own.read', 'tenant'),
  ('learner', 'education', 'records.own.read', 'tenant'),
  ('teacher', 'education', 'teacher_assignments.read', 'tenant'),
  ('teacher', 'education', 'marks.manage', 'tenant'),
  ('teacher', 'education', 'attendance.manage', 'tenant');
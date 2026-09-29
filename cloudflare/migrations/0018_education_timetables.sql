CREATE TABLE IF NOT EXISTS timetables (
  id TEXT PRIMARY KEY,
  school_id TEXT,
  class_name TEXT,
  day TEXT,
  period TEXT,
  subject TEXT,
  teacher_id TEXT
);
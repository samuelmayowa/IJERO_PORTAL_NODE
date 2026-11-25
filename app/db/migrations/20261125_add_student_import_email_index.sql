ALTER TABLE student_imports
  ADD INDEX idx_student_imports_email_id (student_email, id);

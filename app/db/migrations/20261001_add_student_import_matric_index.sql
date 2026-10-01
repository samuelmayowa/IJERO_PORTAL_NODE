ALTER TABLE student_imports
  ADD INDEX idx_student_imports_matric_id (matric_number, id);

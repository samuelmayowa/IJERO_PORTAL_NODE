ALTER TABLE admission_document_templates
  ADD COLUMN IF NOT EXISTS removed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS removed_by INT NULL;

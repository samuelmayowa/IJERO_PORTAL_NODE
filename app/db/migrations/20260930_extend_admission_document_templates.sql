ALTER TABLE admission_document_templates
  ADD COLUMN IF NOT EXISTS title_line_2 VARCHAR(220) NULL AFTER title,
  ADD COLUMN IF NOT EXISTS attachment_path VARCHAR(500) NULL AFTER registrar_signature_path,
  ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL AFTER attachment_path;

ALTER TABLE admission_document_templates
  ADD COLUMN title_line_2 VARCHAR(220) NULL AFTER title,
  ADD COLUMN attachment_path VARCHAR(500) NULL AFTER registrar_signature_path,
  ADD COLUMN attachment_name VARCHAR(255) NULL AFTER attachment_path;

SET @has_removed_at = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admission_document_templates'
    AND COLUMN_NAME = 'removed_at'
);
SET @add_removed_at = IF(
  @has_removed_at = 0,
  'ALTER TABLE admission_document_templates ADD COLUMN removed_at DATETIME NULL',
  'SELECT 1'
);
PREPARE admission_template_stmt FROM @add_removed_at;
EXECUTE admission_template_stmt;
DEALLOCATE PREPARE admission_template_stmt;

SET @has_removed_by = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admission_document_templates'
    AND COLUMN_NAME = 'removed_by'
);
SET @add_removed_by = IF(
  @has_removed_by = 0,
  'ALTER TABLE admission_document_templates ADD COLUMN removed_by INT NULL',
  'SELECT 1'
);
PREPARE admission_template_stmt FROM @add_removed_by;
EXECUTE admission_template_stmt;
DEALLOCATE PREPARE admission_template_stmt;

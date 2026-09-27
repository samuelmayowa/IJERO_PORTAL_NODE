CREATE TABLE IF NOT EXISTS admission_subject_catalogue (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  normalized_name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT NULL,
  updated_by BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admission_subject_name (normalized_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO admission_subject_catalogue (name,normalized_name)
VALUES ('English Language','english language'),('Mathematics','mathematics'),('Biology','biology'),('Chemistry','chemistry');

ALTER TABLE departments ADD COLUMN IF NOT EXISTS code VARCHAR(24) NULL AFTER name;
CREATE UNIQUE INDEX uq_departments_code ON departments (code);

ALTER TABLE payment_types ADD COLUMN IF NOT EXISTS is_compulsory TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;
UPDATE payment_types SET is_compulsory=1 WHERE LOWER(CONCAT_WS(' ',name,purpose)) LIKE '%compulsory%';
ALTER TABLE payment_invoices ADD COLUMN IF NOT EXISTS session_id INT NULL AFTER payment_type_id;
CREATE INDEX idx_payment_invoice_session ON payment_invoices (session_id,status,payment_type_id);

ALTER TABLE portal_announcements ADD COLUMN IF NOT EXISTS updated_by BIGINT NULL AFTER created_by;
ALTER TABLE portal_announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id BIGINT NOT NULL,
  public_user_id INT NOT NULL,
  read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (announcement_id,public_user_id),
  INDEX idx_announcement_read_user (public_user_id,read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE matric_number_sequences DROP INDEX uq_matric_sequence_scope;
ALTER TABLE matric_number_sequences ADD UNIQUE KEY uq_matric_sequence_session (session_id);
ALTER TABLE matric_number_assignments ADD COLUMN IF NOT EXISTS admission_year VARCHAR(4) NULL AFTER session_id;
ALTER TABLE matric_number_assignments ADD UNIQUE KEY uq_matric_session_sequence (session_id,sequence_number);

ALTER TABLE admission_document_templates ADD COLUMN IF NOT EXISTS watermark_text VARCHAR(180) NULL;
ALTER TABLE admission_document_templates ADD COLUMN IF NOT EXISTS watermark_image_path VARCHAR(255) NULL;
ALTER TABLE admission_document_templates ADD COLUMN IF NOT EXISTS watermark_opacity DECIMAL(4,2) NOT NULL DEFAULT 0.10;

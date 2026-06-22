CREATE TABLE IF NOT EXISTS application_documents (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,

  document_type ENUM(
    'PASSPORT',
    'JAMB_RESULT',
    'OLEVEL_RESULT',
    'BIRTH_CERTIFICATE',
    'LGA_IDENTIFICATION',
    'OTHER'
  ) NOT NULL,

  document_label VARCHAR(180) NULL,
  original_filename VARCHAR(255) NOT NULL,
  stored_filename VARCHAR(255) NOT NULL,
  storage_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  file_extension VARCHAR(20) NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  file_hash CHAR(64) NULL,

  uploaded_by_applicant_user_id INT NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  replaced_at DATETIME NULL,
  deleted_at DATETIME NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_application_documents_application (
    applicant_application_id
  ),

  INDEX idx_application_documents_current (
    applicant_application_id,
    document_type,
    is_current
  ),

  INDEX idx_application_documents_uploader (
    uploaded_by_applicant_user_id
  )
);

CREATE TABLE IF NOT EXISTS matric_number_aliases (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  public_user_id INT NOT NULL,
  applicant_application_id BIGINT NOT NULL,
  matric_number VARCHAR(80) NOT NULL,
  replacement_matric_number VARCHAR(80) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  changed_by INT NULL,
  superseded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_matric_alias_number (matric_number),
  INDEX idx_matric_alias_user (public_user_id),
  INDEX idx_matric_alias_application (applicant_application_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

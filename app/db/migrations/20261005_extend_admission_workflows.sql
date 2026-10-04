-- Additive admission workflow extensions. Existing application/payment records
-- remain untouched and continue to be the source of truth.

ALTER TABLE programmes
  ADD COLUMN acronym VARCHAR(30) NULL AFTER name;

ALTER TABLE public_users
  ADD COLUMN gender VARCHAR(30) NULL AFTER dob,
  ADD COLUMN address VARCHAR(500) NULL AFTER phone;

CREATE UNIQUE INDEX uq_programmes_acronym ON programmes (acronym);

CREATE TABLE IF NOT EXISTS programme_compulsory_fee_rules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  application_form_id INT NOT NULL,
  programme_id INT NOT NULL,
  charge_name VARCHAR(180) NOT NULL DEFAULT 'Compulsory Fee',
  amount DECIMAL(12,2) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_compulsory_form_programme_charge (application_form_id, programme_id, charge_name),
  INDEX idx_compulsory_programme_active (programme_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admission_import_batches (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  import_type ENUM('ENTRANCE_SCORE','BULK_ADMISSION') NOT NULL,
  session_id INT NULL,
  original_filename VARCHAR(255) NOT NULL,
  total_rows INT UNSIGNED NOT NULL DEFAULT 0,
  successful_rows INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_rows INT UNSIGNED NOT NULL DEFAULT 0,
  error_summary TEXT NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admission_import_type_date (import_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admission_score_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,
  application_form_id INT NOT NULL,
  applicant_user_id INT NOT NULL,
  import_batch_id BIGINT NULL,
  previous_score DECIMAL(8,2) NULL,
  new_score DECIMAL(8,2) NOT NULL,
  changed_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_score_history_application (applicant_application_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

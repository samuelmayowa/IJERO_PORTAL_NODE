CREATE TABLE IF NOT EXISTS programme_acceptance_fee_rules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  application_form_id INT NOT NULL,
  programme_id INT NOT NULL,
  charge_name VARCHAR(180) NOT NULL DEFAULT 'Acceptance Fee',
  amount DECIMAL(12,2) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acceptance_form_programme_charge (application_form_id,programme_id,charge_name),
  INDEX idx_acceptance_programme_active (programme_id,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_fee_variation_invoices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,
  invoice_id BIGINT NOT NULL,
  fee_stage ENUM('ACCEPTANCE','COMPULSORY') NOT NULL,
  expected_total DECIMAL(12,2) NOT NULL,
  paid_before DECIMAL(12,2) NOT NULL DEFAULT 0,
  variation_amount DECIMAL(12,2) NOT NULL,
  status ENUM('PENDING','PAID','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_application_variation_invoice (invoice_id),
  INDEX idx_application_variation_stage (applicant_application_id,fee_stage,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE admission_settings
  ADD COLUMN letter_printing_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER acceptance_required_for_letter;

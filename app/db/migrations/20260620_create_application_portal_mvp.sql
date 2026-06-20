CREATE TABLE IF NOT EXISTS application_forms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  slug VARCHAR(150) NOT NULL,
  title VARCHAR(180) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'GENERAL',
  description TEXT NULL,
  instructions TEXT NULL,
  session_id INT NOT NULL,
  application_payment_type_id INT NULL,
  acceptance_payment_type_id INT NULL,
  opens_at DATETIME NOT NULL,
  closes_at DATETIME NOT NULL,
  status ENUM('DRAFT','OPEN','CLOSED','INACTIVE') NOT NULL DEFAULT 'DRAFT',
  requires_prerequisite TINYINT(1) NOT NULL DEFAULT 0,
  prerequisite_match_mode VARCHAR(50) NOT NULL DEFAULT 'NONE',
  allow_multiple_applications TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_application_forms_code (code),
  UNIQUE KEY uq_application_forms_slug (slug),
  INDEX idx_application_forms_session (session_id),
  INDEX idx_application_forms_status_dates (status, opens_at, closes_at)
);

CREATE TABLE IF NOT EXISTS application_form_charges (
  id INT AUTO_INCREMENT PRIMARY KEY,
  application_form_id INT NOT NULL,
  charge_name VARCHAR(180) NOT NULL,
  charge_stage ENUM('APPLICATION','ACCEPTANCE') NOT NULL DEFAULT 'APPLICATION',
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  display_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_application_form_charges_form (application_form_id),
  INDEX idx_application_form_charges_stage (application_form_id, charge_stage, is_active)
);

CREATE TABLE IF NOT EXISTS applicant_applications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  application_form_id INT NOT NULL,
  applicant_user_id INT NOT NULL,
  application_number VARCHAR(80) NOT NULL,
  programme_choice VARCHAR(180) NULL,
  qualification_summary TEXT NULL,
  additional_note TEXT NULL,
  form_data LONGTEXT NULL,
  application_invoice_id BIGINT NULL,
  acceptance_invoice_id BIGINT NULL,
  application_payment_status ENUM('NOT_REQUIRED','UNPAID','PENDING','PAID','FAILED')
    NOT NULL DEFAULT 'UNPAID',
  acceptance_payment_status ENUM('NOT_AVAILABLE','UNPAID','PENDING','PAID','FAILED')
    NOT NULL DEFAULT 'NOT_AVAILABLE',
  status ENUM(
    'DRAFT',
    'AWAITING_PAYMENT',
    'IN_PROGRESS',
    'SUBMITTED',
    'UNDER_REVIEW',
    'ADMITTED',
    'REJECTED',
    'WITHDRAWN'
  ) NOT NULL DEFAULT 'DRAFT',
  submitted_at DATETIME NULL,
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  internal_note TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_applicant_application_number (application_number),
  INDEX idx_applicant_form_user (application_form_id, applicant_user_id),
  INDEX idx_applicant_applications_user (applicant_user_id),
  INDEX idx_applicant_applications_form_status (application_form_id, status),
  INDEX idx_applicant_application_invoice (application_invoice_id),
  INDEX idx_applicant_acceptance_invoice (acceptance_invoice_id)
);

CREATE TABLE IF NOT EXISTS application_payment_lines (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,
  application_form_charge_id INT NULL,
  invoice_id BIGINT NULL,
  charge_stage ENUM('APPLICATION','ACCEPTANCE') NOT NULL DEFAULT 'APPLICATION',
  charge_name VARCHAR(180) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  payment_status ENUM('NO_CHARGE','UNPAID','PENDING','PAID','FAILED')
    NOT NULL DEFAULT 'UNPAID',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_application_payment_lines_application (applicant_application_id),
  INDEX idx_application_payment_lines_invoice (invoice_id),
  INDEX idx_application_payment_lines_stage (applicant_application_id, charge_stage)
);

CREATE TABLE IF NOT EXISTS application_prerequisite_batches (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  application_form_id INT NOT NULL,
  original_filename VARCHAR(255) NULL,
  imported_rows INT NOT NULL DEFAULT 0,
  valid_rows INT NOT NULL DEFAULT 0,
  invalid_rows INT NOT NULL DEFAULT 0,
  status ENUM('UPLOADED','PROCESSED','FAILED') NOT NULL DEFAULT 'UPLOADED',
  uploaded_by INT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_application_prerequisite_batches_form (application_form_id)
);

CREATE TABLE IF NOT EXISTS application_prerequisites (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  application_form_id INT NOT NULL,
  batch_id BIGINT NULL,
  row_number INT NULL,
  candidate_reference VARCHAR(100) NULL,
  first_name VARCHAR(120) NULL,
  middle_name VARCHAR(120) NULL,
  surname VARCHAR(120) NULL,
  email VARCHAR(180) NULL,
  phone VARCHAR(50) NULL,
  jamb_total_score DECIMAL(8,2) NULL,
  state_of_origin VARCHAR(120) NULL,
  lga VARCHAR(120) NULL,
  gender VARCHAR(30) NULL,
  raw_data LONGTEXT NULL,
  matched_applicant_user_id INT NULL,
  match_status ENUM('UNMATCHED','MATCHED','USED','INVALID') NOT NULL DEFAULT 'UNMATCHED',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_application_prerequisites_form (application_form_id),
  INDEX idx_application_prerequisites_batch (batch_id),
  INDEX idx_application_prerequisites_reference (candidate_reference),
  INDEX idx_application_prerequisites_email (email),
  INDEX idx_application_prerequisites_phone (phone),
  INDEX idx_application_prerequisites_match (matched_applicant_user_id, match_status)
);

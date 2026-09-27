-- Admission management foundation. Additive by design: existing application and
-- payment tables remain the source of truth while features are rolled out.

CREATE TABLE IF NOT EXISTS portal_user_roles (
  public_user_id INT NOT NULL,
  role ENUM('applicant','student') NOT NULL,
  granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  granted_by INT NULL,
  PRIMARY KEY (public_user_id, role),
  INDEX idx_portal_user_roles_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO portal_user_roles (public_user_id, role)
SELECT id, role FROM public_users WHERE role IN ('applicant','student');

CREATE TABLE IF NOT EXISTS admission_criteria (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  application_form_id INT NULL,
  school_id INT NULL,
  department_id INT NULL,
  programme_id INT NULL,
  minimum_score DECIMAL(8,2) NULL,
  score_mode ENUM('RAW','PERCENT') NOT NULL DEFAULT 'RAW',
  maximum_score DECIMAL(8,2) NULL,
  score_required TINYINT(1) NOT NULL DEFAULT 1,
  minimum_olevel_credits TINYINT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT NULL,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_admission_criteria_lookup
    (session_id, application_form_id, school_id, department_id, programme_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admission_criterion_subjects (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  admission_criterion_id BIGINT NOT NULL,
  subject_name VARCHAR(120) NOT NULL,
  minimum_grade VARCHAR(20) NULL,
  is_mandatory TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admission_criterion_subject
    (admission_criterion_id, subject_name),
  CONSTRAINT fk_admission_criterion_subject
    FOREIGN KEY (admission_criterion_id) REFERENCES admission_criteria(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admission_decisions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,
  session_id INT NOT NULL,
  offered_school_id INT NULL,
  offered_department_id INT NULL,
  offered_programme_id INT NULL,
  offered_programme_name VARCHAR(200) NULL,
  entrance_score DECIMAL(8,2) NULL,
  criterion_id BIGINT NULL,
  status ENUM('ADMITTED','REVOKED') NOT NULL DEFAULT 'ADMITTED',
  is_manual_override TINYINT(1) NOT NULL DEFAULT 0,
  decision_reason TEXT NULL,
  admitted_by INT NULL,
  admitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_by INT NULL,
  revoked_at DATETIME NULL,
  revocation_reason TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admission_application (applicant_application_id),
  INDEX idx_admission_decisions_session_status (session_id, status),
  INDEX idx_admission_decisions_programme (offered_programme_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admission_settings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  application_form_id INT NULL,
  acceptance_required_for_letter TINYINT(1) NOT NULL DEFAULT 1,
  matriculation_enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admission_settings_scope (session_id, application_form_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS portal_notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  public_user_id INT NOT NULL,
  applicant_application_id BIGINT NULL,
  notification_type VARCHAR(60) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  action_url VARCHAR(500) NULL,
  read_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_portal_notifications_user (public_user_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  notification_id BIGINT NOT NULL,
  channel ENUM('EMAIL') NOT NULL DEFAULT 'EMAIL',
  recipient VARCHAR(180) NOT NULL,
  status ENUM('PENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  sent_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_notification_deliveries_status (status, attempts),
  CONSTRAINT fk_notification_delivery_notification
    FOREIGN KEY (notification_id) REFERENCES portal_notifications(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admission_document_templates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  document_type ENUM('ADMISSION_NOTIFICATION','ADMISSION_LETTER','SCREENING_SLIP') NOT NULL,
  session_id INT NULL,
  application_form_id INT NULL,
  title VARCHAR(220) NOT NULL,
  body_html MEDIUMTEXT NOT NULL,
  version_no INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  created_by INT NULL,
  published_by INT NULL,
  published_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_document_template_resolution
    (document_type, session_id, application_form_id, status, version_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issued_admission_documents (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,
  admission_decision_id BIGINT NULL,
  screening_assignment_id BIGINT NULL,
  template_id BIGINT NULL,
  document_type ENUM('ADMISSION_NOTIFICATION','ADMISSION_LETTER','SCREENING_SLIP') NOT NULL,
  document_number VARCHAR(80) NOT NULL,
  verification_token_hash CHAR(64) NOT NULL,
  status ENUM('VALID','REVOKED','SUPERSEDED') NOT NULL DEFAULT 'VALID',
  issued_by INT NULL,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  UNIQUE KEY uq_issued_document_number (document_number),
  UNIQUE KEY uq_issued_document_token (verification_token_hash),
  INDEX idx_issued_document_application
    (applicant_application_id, document_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS screening_schedules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  application_form_id INT NULL,
  school_id INT NULL,
  department_id INT NULL,
  programme_id INT NULL,
  applicant_application_id BIGINT NULL,
  screening_type VARCHAR(120) NOT NULL DEFAULT 'Entrance Screening',
  screening_date DATE NOT NULL,
  reporting_time TIME NULL,
  start_time TIME NULL,
  venue VARCHAR(255) NOT NULL,
  batch_name VARCHAR(120) NULL,
  instructions TEXT NULL,
  status ENUM('DRAFT','PUBLISHED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_screening_resolution
    (session_id, application_form_id, school_id, department_id, programme_id, applicant_application_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS portal_announcements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(220) NOT NULL,
  body TEXT NOT NULL,
  audience_role ENUM('applicant','student','both') NOT NULL DEFAULT 'both',
  session_id INT NULL,
  application_form_id INT NULL,
  school_id INT NULL,
  department_id INT NULL,
  programme_id INT NULL,
  admission_status VARCHAR(30) NULL,
  priority ENUM('NORMAL','IMPORTANT','URGENT') NOT NULL DEFAULT 'NORMAL',
  publish_at DATETIME NOT NULL,
  expires_at DATETIME NULL,
  status ENUM('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_announcement_visibility (status, audience_role, publish_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS applicant_student_transitions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,
  public_user_id INT NOT NULL,
  admission_decision_id BIGINT NOT NULL,
  acceptance_invoice_id BIGINT NOT NULL,
  compulsory_invoice_id BIGINT NOT NULL,
  status ENUM('PENDING_MATRICULATION','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING_MATRICULATION',
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_transition_application (applicant_application_id),
  UNIQUE KEY uq_transition_user_application (public_user_id, applicant_application_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matric_number_sequences (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  programme_id INT NOT NULL DEFAULT 0,
  department_id INT NOT NULL DEFAULT 0,
  last_number INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_matric_sequence_scope (session_id, programme_id, department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matric_number_assignments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  applicant_application_id BIGINT NOT NULL,
  public_user_id INT NOT NULL,
  session_id INT NOT NULL,
  programme_id INT NULL,
  department_id INT NULL,
  sequence_number INT UNSIGNED NOT NULL,
  matric_number VARCHAR(80) NOT NULL,
  assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_matric_assignment_application (applicant_application_id),
  UNIQUE KEY uq_matric_assignment_user (public_user_id),
  UNIQUE KEY uq_matric_assignment_number (matric_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS portal_audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_user_id INT NULL,
  actor_role VARCHAR(60) NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80) NULL,
  reason TEXT NULL,
  old_values LONGTEXT NULL,
  new_values LONGTEXT NULL,
  request_ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_portal_audit_entity (entity_type, entity_id, created_at),
  INDEX idx_portal_audit_actor (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Preserve admissions that pre-date the dedicated decision history.
INSERT IGNORE INTO admission_decisions
  (applicant_application_id, session_id, offered_programme_name, status,
   decision_reason, admitted_at)
SELECT aa.id, af.session_id, aa.programme_choice, 'ADMITTED',
       'Backfilled from existing admitted application status',
       COALESCE(aa.reviewed_at, aa.updated_at, aa.submitted_at, aa.created_at)
FROM applicant_applications aa
JOIN application_forms af ON af.id=aa.application_form_id
WHERE aa.status='ADMITTED';

ALTER TABLE application_form_charges MODIFY charge_stage ENUM('APPLICATION','ACCEPTANCE','COMPULSORY') NOT NULL DEFAULT 'APPLICATION';
ALTER TABLE application_payment_lines MODIFY charge_stage ENUM('APPLICATION','ACCEPTANCE','COMPULSORY') NOT NULL DEFAULT 'APPLICATION';
ALTER TABLE application_forms ADD COLUMN compulsory_payment_type_id INT NULL AFTER acceptance_payment_type_id;
ALTER TABLE applicant_applications ADD COLUMN compulsory_invoice_id BIGINT NULL AFTER acceptance_invoice_id;
ALTER TABLE applicant_applications ADD COLUMN compulsory_payment_status ENUM('NOT_AVAILABLE','UNPAID','PENDING','PAID','FAILED') NOT NULL DEFAULT 'NOT_AVAILABLE' AFTER acceptance_payment_status;
CREATE INDEX idx_applicant_compulsory_invoice ON applicant_applications (compulsory_invoice_id);

CREATE TABLE IF NOT EXISTS tuition_late_fee_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  session_id INT NOT NULL,
  semester VARCHAR(20) NOT NULL DEFAULT 'ALL',
  deadline_at DATETIME NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  scope_type ENUM('ALL','SCHOOL','DEPARTMENT','PROGRAMME') NOT NULL DEFAULT 'ALL',
  school_id INT NULL,
  department_id INT NULL,
  programme_id INT NULL,
  notice_message TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_tlfr_session_semester (session_id, semester),
  INDEX idx_tlfr_scope (scope_type, school_id, department_id, programme_id),
  INDEX idx_tlfr_deadline (deadline_at),
  INDEX idx_tlfr_active (is_active)
);

CREATE TABLE IF NOT EXISTS tuition_late_fee_rule_payment_types (
  rule_id INT NOT NULL,
  payment_type_id INT NOT NULL,
  PRIMARY KEY (rule_id, payment_type_id),
  INDEX idx_tlfrpt_payment_type (payment_type_id),
  CONSTRAINT fk_tlfrpt_rule
    FOREIGN KEY (rule_id)
    REFERENCES tuition_late_fee_rules(id)
    ON DELETE CASCADE
);

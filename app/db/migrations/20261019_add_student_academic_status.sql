ALTER TABLE student_profiles
  ADD COLUMN academic_status ENUM('ACTIVE','GRADUATED','SPILLOVER')
  NOT NULL DEFAULT 'ACTIVE' AFTER level;

ALTER TABLE student_promotion_items
  ADD COLUMN previous_academic_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' AFTER new_level,
  ADD COLUMN new_academic_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' AFTER previous_academic_status;

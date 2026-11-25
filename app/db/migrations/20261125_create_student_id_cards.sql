CREATE TABLE IF NOT EXISTS student_id_cards (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_user_id INT NOT NULL,
  public_code CHAR(32) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_student_id_cards_user (public_user_id),
  UNIQUE KEY uq_student_id_cards_code (public_code),
  CONSTRAINT fk_student_id_cards_user FOREIGN KEY (public_user_id)
    REFERENCES public_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO student_id_cards (public_user_id, public_code)
SELECT pu.id, LOWER(REPLACE(UUID(), '-', ''))
FROM public_users pu
WHERE pu.role = 'student'
   OR EXISTS (
     SELECT 1 FROM portal_user_roles pur
     WHERE pur.public_user_id = pu.id AND pur.role = 'student'
   );

CREATE TABLE IF NOT EXISTS student_promotion_batches (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_session_id INT NOT NULL,
  target_session_id INT NOT NULL,
  promoted_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_promotion_session_transition (source_session_id, target_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_promotion_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  batch_id BIGINT NOT NULL,
  public_user_id INT NOT NULL,
  programme_id INT NOT NULL,
  previous_level VARCHAR(40) NOT NULL,
  new_level VARCHAR(40) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_promotion_batch_user (batch_id, public_user_id),
  KEY idx_student_promotion_user (public_user_id),
  CONSTRAINT fk_student_promotion_item_batch
    FOREIGN KEY (batch_id) REFERENCES student_promotion_batches(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

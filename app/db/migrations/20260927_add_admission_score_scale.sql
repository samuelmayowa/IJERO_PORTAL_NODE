ALTER TABLE admission_criteria
  ADD COLUMN score_mode ENUM('RAW','PERCENT') NOT NULL DEFAULT 'RAW' AFTER minimum_score,
  ADD COLUMN maximum_score DECIMAL(8,2) NULL AFTER score_mode;

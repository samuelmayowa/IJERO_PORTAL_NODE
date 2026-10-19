-- Configuration only: this migration does not change or promote students.
ALTER TABLE programmes
  ADD COLUMN entry_level VARCHAR(20) NULL AFTER acronym,
  ADD COLUMN graduating_level VARCHAR(20) NULL AFTER entry_level;

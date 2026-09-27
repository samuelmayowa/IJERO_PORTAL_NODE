ALTER TABLE admission_settings
  ADD COLUMN IF NOT EXISTS registrar_name VARCHAR(180) NULL AFTER matriculation_enabled,
  ADD COLUMN IF NOT EXISTS registrar_position VARCHAR(180) NULL AFTER registrar_name,
  ADD COLUMN IF NOT EXISTS registrar_signature_path VARCHAR(500) NULL AFTER registrar_position;

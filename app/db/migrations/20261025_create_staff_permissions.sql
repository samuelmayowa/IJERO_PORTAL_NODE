CREATE TABLE IF NOT EXISTS staff_permission_overrides (
  staff_id INT NOT NULL,
  permission_key VARCHAR(100) NOT NULL,
  allowed TINYINT(1) NOT NULL DEFAULT 1,
  granted_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_id, permission_key),
  CONSTRAINT fk_staff_permission_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO roles(name) VALUES ('superadmin'),('adminict') ON DUPLICATE KEY UPDATE name=VALUES(name);
INSERT IGNORE INTO user_roles(user_id,role_id) SELECT s.id,r.id FROM staff s JOIN roles r ON r.name='superadmin' WHERE LOWER(s.username)='admin';
UPDATE staff SET status='INACTIVE' WHERE LOWER(username)='adminsupport';

INSERT INTO portal_audit_log(actor_role,action,entity_type,entity_id,reason,new_values)
SELECT 'system','SUPERADMIN_BOOTSTRAPPED','staff',CAST(id AS CHAR),'Initial protected superadmin account',JSON_OBJECT('username',username,'role','superadmin')
FROM staff WHERE LOWER(username)='admin' AND NOT EXISTS (SELECT 1 FROM portal_audit_log WHERE action='SUPERADMIN_BOOTSTRAPPED');
INSERT INTO portal_audit_log(actor_role,action,entity_type,entity_id,reason,new_values)
SELECT 'system','STAFF_ACCOUNT_DEACTIVATED','staff',CAST(id AS CHAR),'Unrecognised administrator account secured pending ownership verification',JSON_OBJECT('username',username,'status','INACTIVE')
FROM staff WHERE LOWER(username)='adminsupport' AND NOT EXISTS (SELECT 1 FROM portal_audit_log WHERE action='STAFF_ACCOUNT_DEACTIVATED' AND entity_id=CAST(staff.id AS CHAR));

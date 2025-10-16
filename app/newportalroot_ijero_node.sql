SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS office_locations;
DROP TABLE IF EXISTS staff;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS schools;
DROP TABLE IF EXISTS semesters;
DROP TABLE IF EXISTS sessions;

CREATE TABLE schools (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schools_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE departments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id INT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dept_school_name (school_id, name),
  CONSTRAINT fk_dept_school
    FOREIGN KEY (school_id) REFERENCES schools(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE staff (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  staff_no VARCHAR(64) NULL,
  full_name VARCHAR(160) NOT NULL,
  username VARCHAR(64) NOT NULL,
  email VARCHAR(160) NULL,
  phone VARCHAR(40) NULL,
  password_hash VARCHAR(255) NOT NULL,
  level VARCHAR(32) NULL,
  highest_qualification VARCHAR(120) NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  school_id INT UNSIGNED NULL,
  department_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_staff_username (username),
  UNIQUE KEY uq_staff_email (email),
  KEY idx_staff_school (school_id),
  KEY idx_staff_dept (department_id),
  CONSTRAINT fk_staff_school
    FOREIGN KEY (school_id) REFERENCES schools(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_staff_dept
    FOREIGN KEY (department_id) REFERENCES departments(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE roles (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_slug (slug),
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_roles (
  user_id INT UNSIGNED NOT NULL,
  role_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, role_id),
  KEY idx_user_roles_role (role_id),
  CONSTRAINT fk_user_roles_user
    FOREIGN KEY (user_id) REFERENCES staff(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_user_roles_role
    FOREIGN KEY (role_id) REFERENCES roles(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE office_locations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id INT UNSIGNED NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  latitude DECIMAL(10,6) NOT NULL,
  longitude DECIMAL(10,6) NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_office_location (school_id, department_id),
  KEY idx_office_school (school_id),
  KEY idx_office_dept (department_id),
  CONSTRAINT fk_office_school
    FOREIGN KEY (school_id) REFERENCES schools(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_office_dept
    FOREIGN KEY (department_id) REFERENCES departments(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_office_created_by
    FOREIGN KEY (created_by) REFERENCES staff(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(32) NOT NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE semesters (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name ENUM('First','Second','Summer / Carry Over') NOT NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_semesters_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO schools (name) VALUES ('Main School');

INSERT INTO departments (school_id, name)
SELECT id, 'Environmental Health Assistance' FROM schools WHERE name='Main School';

INSERT INTO roles (name, slug) VALUES
('admin','admin'),('staff','staff'),('lecturer','lecturer'),('applicant','applicant'),
('student','student'),('dean','dean'),('ict','ict'),('student union','student-union'),
('bursary','bursary'),('registry','registry'),('admission officer','admission-officer'),
('auditor','auditor'),('health center','health-center'),('works','works'),
('library','library'),('provost','provost'),('hod','hod');

INSERT INTO sessions (name, is_current) VALUES ('2025/2026', 1);
INSERT INTO semesters (name, is_current) VALUES ('First', 1);

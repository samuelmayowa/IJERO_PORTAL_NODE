// app/web/controllers/studentUpload.controller.js

import fs from 'fs';
import xlsx from 'xlsx';
import pool from '../../core/db.js';

// small helper to clean cell values
function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

// placeholders for NOT NULL columns that are not in the Excel
const DOB_PLACEHOLDER = '2000-01-01'; // dummy date, to be replaced when student registers
const PHONE_PLACEHOLDER = '';         // empty string is allowed for NOT NULL varchar
const PASSWORD_PLACEHOLDER = 'PENDING'; // sentinel; real hash will overwrite on registration

// =================== GET: Upload Page ===================
export function showStudentUploadPage(req, res) {
  const success = req.flash('success')[0] || '';
  const error = req.flash('error')[0] || '';
  let stats = null;

  try {
    const raw = req.flash('uploadStats')[0];
    stats = raw ? JSON.parse(raw) : null;
  } catch {
    stats = null;
  }

  res.render('students/upload', {
    title: 'Upload Student Data',
    pageTitle: 'Upload Student Data',
    csrfToken: res.locals.csrfToken || null,
    success,
    error,
    stats
  });
}

// =================== POST: Handle Upload ===================
export async function handleStudentUpload(req, res) {
  const file = req.file;

  if (!file) {
    req.flash('error', 'Please choose an Excel file to upload.');
    return res.redirect('/staff/students/upload');
  }

  const filePath = file.path;

  const summary = {
    totalRows: 0,
    importedRows: 0,    // rows saved in student_imports
    skippedRows: 0,     // rows missing required fields
    createdUsers: 0,    // new rows in public_users
    updatedUsers: 0,    // existing public_users updated
    userSyncErrors: 0   // rows where public_users insert/update failed
  };

  try {
    // read workbook
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    summary.totalRows = rows.length;

    for (const row of rows) {
      // Map expected headers -> variables
      const accessCode     = clean(row.accessCode);
      const studentEmail   = clean(row.studentEmail);
      const matricNumber   = clean(row.matricNumber);
      const firstName      = clean(row.firstName);
      const middleName     = clean(row.middleName);
      const lastName       = clean(row.lastName);
      const yearOfEntry    = clean(row.yearOfEntry);
      const school         = clean(row.School);
      const department     = clean(row.department);
      const programme      = clean(row.programme);
      const studentLevel   = clean(row.studentLevel);
      const stateOfOrigin  = clean(row.stateOfOrigin);
      const lga            = clean(row.LGA);

      // Minimal validation: need accessCode + email + name
      if (!accessCode || !studentEmail || !firstName || !lastName) {
        summary.skippedRows += 1;
        continue;
      }

      // -------- 1) Save raw row into student_imports -----------
      await pool.query(
        `
        INSERT INTO student_imports
          (access_code, student_email, matric_number, first_name, middle_name, last_name,
           year_of_entry, school, department, programme, student_level, state_of_origin, lga)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          matric_number   = VALUES(matric_number),
          first_name      = VALUES(first_name),
          middle_name     = VALUES(middle_name),
          last_name       = VALUES(last_name),
          year_of_entry   = VALUES(year_of_entry),
          school          = VALUES(school),
          department      = VALUES(department),
          programme       = VALUES(programme),
          student_level   = VALUES(student_level),
          state_of_origin = VALUES(state_of_origin),
          lga             = VALUES(lga),
          updated_at      = NOW()
        `,
        [
          accessCode,
          studentEmail.toLowerCase(),
          matricNumber,
          firstName,
          middleName,
          lastName,
          yearOfEntry,
          school,
          department,
          programme,
          studentLevel,
          stateOfOrigin,
          lga
        ]
      );

      summary.importedRows += 1;

      // -------- 2) Mirror core data into public_users ----------
      //   This creates/updates stub student accounts with matric_number, access_code, etc.
      //   password_hash uses a placeholder so NOT NULL is satisfied; real password will be
      //   set during portal registration.

      const emailLower = studentEmail.toLowerCase();

      try {
        const [existingRows] = await pool.query(
          'SELECT id, role FROM public_users WHERE username = ? LIMIT 1',
          [emailLower]
        );

        if (!existingRows.length) {
          // new student row
          await pool.query(
            `
            INSERT INTO public_users
              (role, first_name, middle_name, last_name,
               dob, state_of_origin, lga, phone,
               username, access_code, matric_number,
               password_hash, status, created_at)
            VALUES
              ('student', ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?, ?,
               ?, 'ACTIVE', NOW())
            `,
            [
              firstName,
              middleName,
              lastName,
              DOB_PLACEHOLDER,
              stateOfOrigin,
              lga,
              PHONE_PLACEHOLDER,
              emailLower,
              accessCode,
              matricNumber,
              PASSWORD_PLACEHOLDER
            ]
          );
          summary.createdUsers += 1;
        } else {
          // update existing (e.g. applicant becoming student)
          const existing = existingRows[0];

          await pool.query(
            `
            UPDATE public_users
            SET
              role            = 'student',
              first_name      = COALESCE(?, first_name),
              middle_name     = COALESCE(?, middle_name),
              last_name       = COALESCE(?, last_name),
              state_of_origin = COALESCE(?, state_of_origin),
              lga             = COALESCE(?, lga),
              access_code     = COALESCE(?, access_code),
              matric_number   = COALESCE(?, matric_number)
            WHERE id = ?
            `,
            [
              firstName,
              middleName,
              lastName,
              stateOfOrigin,
              lga,
              accessCode,
              matricNumber,
              existing.id
            ]
          );
          summary.updatedUsers += 1;
        }
      } catch (err) {
        console.error('Error while syncing to public_users for row:', err);
        summary.userSyncErrors += 1;
      }
    }

    let successMsg =
      `Student data imported. Processed ${summary.totalRows} row(s). ` +
      `Saved ${summary.importedRows}, skipped ${summary.skippedRows}. ` +
      `Created ${summary.createdUsers} and updated ${summary.updatedUsers} portal record(s).`;

    if (summary.userSyncErrors) {
      successMsg += ` ${summary.userSyncErrors} row(s) could not be synced to public_users (see server logs).`;
    }

    req.flash('success', successMsg);
    req.flash('uploadStats', JSON.stringify(summary));
  } catch (err) {
    console.error('Error importing student data:', err);
    req.flash(
      'error',
      'Failed to import file. Please confirm the Excel format and try again.'
    );
  } finally {
    // remove temp file
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  return res.redirect('/staff/students/upload');
}

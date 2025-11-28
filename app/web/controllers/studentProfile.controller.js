// app/web/controllers/studentProfile.controller.js
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pool from '../../core/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicRoot = path.join(__dirname, '..', 'public');

// Small helper – get logged-in public user (student) from session
function getCurrentStudent(req) {
  // in this app public users are stored on req.session.publicUser
  return req.session && req.session.publicUser ? req.session.publicUser : null;
}

// Fetch or create empty profile row
async function getOrCreateProfile(userId) {
  const [rows] = await pool.query(
    'SELECT * FROM student_profiles WHERE user_id = ? LIMIT 1',
    [userId]
  );

  if (rows.length) return rows[0];

  await pool.query(
    'INSERT INTO student_profiles (user_id, status) VALUES (?, "INCOMPLETE")',
    [userId]
  );

  const [created] = await pool.query(
    'SELECT * FROM student_profiles WHERE user_id = ? LIMIT 1',
    [userId]
  );
  return created[0];
}

// Expose for other controllers (eg: dashboard) if you need it later
export async function loadStudentProfile(userId) {
  const [rows] = await pool.query(
    'SELECT * FROM student_profiles WHERE user_id = ? LIMIT 1',
    [userId]
  );
  return rows.length ? rows[0] : null;
}

// Helper: load public user + derive email from username (since DB has no email column)
async function getPublicUserWithEmail(userId) {
  const [[publicUser]] = await pool.query(
    `SELECT id, role, first_name, middle_name, last_name,
            dob, state_of_origin, lga, phone, username
     FROM public_users
     WHERE id = ?`,
    [userId]
  );

  let email = null;
  if (publicUser.username && publicUser.username.includes('@')) {
    // registration uses username as email for students
    email = publicUser.username;
  }

  publicUser.email = email; // attach for views
  return publicUser;
}

// =============== GET: Profile page ==================
export async function showStudentProfilePage(req, res, next) {
  console.log('[showStudentProfilePage] ENTER', req.method, req.originalUrl);
  try {
    const student = getCurrentStudent(req);
    if (!student) {
      return res.redirect('/login');
    }

    // registration/basic data (read-only section)
    const publicUser = await getPublicUserWithEmail(student.id);

    const profile = await getOrCreateProfile(student.id);

    // dropdown data
    const [schools] = await pool.query(
      'SELECT id, name FROM schools ORDER BY name ASC'
    );
    const [departments] = await pool.query(
      'SELECT id, school_id, name FROM departments ORDER BY name ASC'
    );
    const [programmes] = await pool.query(
      'SELECT id, school_id, department_id, name FROM programmes ORDER BY name ASC'
    );

    // simple level list
    const levels = ['ND1', 'ND2', 'HND1', 'HND2'];

    const isComplete = profile.status === 'COMPLETE';

    // CSRF token from route-level csurf (see routes file)
    const csrfToken = req.csrfToken();

    res.render('student/profile', {
      pageTitle: 'My Profile',
      csrfToken,
      publicUser,
      profile,
      schools,
      departments,
      programmes,
      levels,
      isComplete
    });
  } catch (err) {
    console.error('Error in showStudentProfilePage:', err);
    next(err);
  }
}

// =============== POST: Save profile ==================
export async function updateStudentProfile(req, res, next) {
  try {
    const student = getCurrentStudent(req);
    if (!student) {
      return res.redirect('/login');
    }

    // current profile (for existing photo AND status)
    const currentProfile = await getOrCreateProfile(student.id);

    // 🔒 Once COMPLETE, student cannot edit anymore via this route
    if (currentProfile.status === 'COMPLETE') {
      req.flash(
        'error',
        'Your profile has already been marked as COMPLETE and can only be updated by authorized staff.'
      );
      return res.redirect('/student/profile');
    }

    const {
      school_id,
      department_id,
      programme_id,
      level,
      phone,
      emergency_name,
      emergency_address,
      emergency_email,
      emergency_phone,
      emergency_relationship,
      email // optional email field from profile form
    } = req.body;

    let photoPath = currentProfile.photo_path || null;

    // Handle passport upload
    if (req.file) {
      // delete old file if any
      if (currentProfile.photo_path) {
        const oldFsPath = path.join(
          publicRoot,
          currentProfile.photo_path.replace(/^\//, '')
        );
        if (fs.existsSync(oldFsPath)) {
          try {
            fs.unlinkSync(oldFsPath);
          } catch {
            // ignore unlink errors
          }
        }
      }
      // multer stored file under app/web/public/uploads/students
      photoPath = `/uploads/students/${req.file.filename}`;
    }

    // Load public user to know existing email (via username)
    const publicUser = await getPublicUserWithEmail(student.id);
    const existingEmail = publicUser.email || null;
    const submittedEmail = (email || '').trim() || null;

    // final email we consider "on file"
    const effectiveEmail = existingEmail || submittedEmail;

    // determine COMPLETE vs INCOMPLETE (email is now required)
    const isComplete =
      school_id &&
      department_id &&
      programme_id &&
      level &&
      phone &&
      emergency_name &&
      emergency_phone &&
      emergency_relationship &&
      effectiveEmail;

    // once it becomes COMPLETE, we keep that status forever for this route
    const status = isComplete ? 'COMPLETE' : 'INCOMPLETE';

    // Simple UPDATE
    await pool.query(
      `UPDATE student_profiles
       SET school_id = ?,
           department_id = ?,
           programme_id = ?,
           level = ?,
           phone = ?,
           emergency_name = ?,
           emergency_address = ?,
           emergency_email = ?,
           emergency_phone = ?,
           emergency_relationship = ?,
           photo_path = ?,
           status = ?
       WHERE user_id = ?`,
      [
        school_id || null,
        department_id || null,
        programme_id || null,
        level || null,
        phone || null,
        emergency_name || null,
        emergency_address || null,
        emergency_email || null,
        emergency_phone || null,
        emergency_relationship || null,
        photoPath,
        status,
        student.id
      ]
    );

    // also keep latest phone on public_users
    if (phone) {
      await pool.query('UPDATE public_users SET phone = ? WHERE id = ?', [
        phone,
        student.id
      ]);
    }

    // If we didn't already have email and the student provided one,
    // store it in public_users.username (your current schema).
    if (!existingEmail && submittedEmail) {
      await pool.query('UPDATE public_users SET username = ? WHERE id = ?', [
        submittedEmail,
        student.id
      ]);
    }

    // keep photo + email on session so header/dashboard can use it
    if (!req.session.publicUser) {
      req.session.publicUser = {};
    }
    req.session.publicUser.photo_path = photoPath;
    if (effectiveEmail) {
      req.session.publicUser.email = effectiveEmail;
      req.session.publicUser.username = effectiveEmail;
    }

    req.flash('success', 'Profile updated successfully.');
    res.redirect('/student/profile');
  } catch (err) {
    console.error('Error in updateStudentProfile:', err);
    next(err);
  }
}

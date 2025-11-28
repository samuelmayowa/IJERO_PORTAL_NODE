// app/web/routes/student-profile.routes.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import csrf from 'csurf';
import { fileURLToPath } from 'url';

import {
  showStudentProfilePage,
  updateStudentProfile
} from '../controllers/studentProfile.controller.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure upload dir is under app/web/public/uploads/students
const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'students');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ===== Multer setup for JPG/PNG passport =====
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const id =
      req.session?.publicUser?.id
        ? `student_${req.session.publicUser.id}`
        : 'student';
    cb(null, `${id}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPG and PNG images are allowed.'));
    }
    cb(null, true);
  }
});

// Route-level CSRF for this router (global CSRF skips /student/profile)
const csrfProtection = csrf({ cookie: false });

// GET profile
router.get('/', csrfProtection, showStudentProfilePage);

// POST save profile  (multer FIRST, then CSRF, then controller)
router.post('/', upload.single('photo'), csrfProtection, updateStudentProfile);

export default router;

// app/web/routes/student-upload.routes.js

import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import csurf from 'csurf';
import {
  showStudentUploadPage,
  handleStudentUpload
} from '../controllers/studentUpload.controller.js';

const router = express.Router();
const csrfProtection = csurf();

// temp directory for uploaded Excel files
const uploadDir = path.join(process.cwd(), 'tmp', 'student-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// attach CSRF
router.use(csrfProtection);
router.use((req, res, next) => {
  try {
    res.locals.csrfToken = req.csrfToken();
  } catch {
    res.locals.csrfToken = null;
  }
  next();
});

// GET upload page
router.get('/upload', showStudentUploadPage);

// POST upload handler (single Excel file)
router.post('/upload', upload.single('studentFile'), handleStudentUpload);

export default router;

// app/web/routes/exam-date.routes.js

import { Router } from 'express';
import {
  examDatePage,
  fetchMyExamCourses,
  saveExamDate
} from '../controllers/examDate.controller.js';

const router = Router();

// No explicit role guard here – same pattern as /staff/lecture-time
router.get('/', examDatePage);

// Optional: /staff/exams/date/set/:id can reuse the same page
router.get('/set/:assignmentId', examDatePage);

// Alias for your existing URL: /staff/exam/set-date/:assignmentId
router.get('/set-date/:assignmentId', examDatePage);

// AJAX endpoint for lecturer's assigned courses (autocomplete)
router.get('/api/my-courses', fetchMyExamCourses);


// Save / update exam date
router.post('/save', saveExamDate);

export default router;

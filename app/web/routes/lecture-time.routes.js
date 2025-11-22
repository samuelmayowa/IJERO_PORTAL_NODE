// app/web/routes/lecture-time.routes.js

import { Router } from 'express';
import {
  lectureTimePage,
  fetchMyAssignedCourses,
  saveLectureTime
} from '../controllers/lectureTime.controller.js';

const router = Router();

// No role guard here — visible to all staff (like attendance)

router.get('/', lectureTimePage);

// Optional: if you later link a button like /staff/lecture-time/set/:id
// we simply reuse the same page handler.
router.get('/set/:assignmentId', lectureTimePage);

// AJAX endpoint for lecturer's assigned courses
router.get('/api/my-courses', fetchMyAssignedCourses);

// Save / update lecture time
router.post('/save', saveLectureTime);

export default router;

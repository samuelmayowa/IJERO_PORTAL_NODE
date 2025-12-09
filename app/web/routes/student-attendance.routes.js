// app/web/routes/student-attendance.routes.js

import { Router } from 'express';
import {
  showMarkAttendancePage,
  submitStudentAttendance,
} from '../controllers/studentAttendance.controller.js';

const router = Router();

// GET /student/attendance
router.get('/', showMarkAttendancePage);

// Optional explicit /mark url
router.get('/mark', showMarkAttendancePage);

// POST /student/attendance/mark
router.post('/mark', submitStudentAttendance);

export default router;

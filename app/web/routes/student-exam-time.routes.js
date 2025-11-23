// app/web/routes/student-exam-time.routes.js

import { Router } from 'express';
import {
  studentExamTimePage,
  studentExamTimePdf
} from '../controllers/studentExamTime.controller.js';

const router = Router();

// /student/exam-time-table
router.get('/', studentExamTimePage);

// /student/exam-time-table/print
router.get('/print', studentExamTimePdf);

export default router;

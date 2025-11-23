// app/web/routes/student-lecture-time.routes.js

import { Router } from 'express';
import { studentLectureTimePage } from '../controllers/studentLectureTime.controller.js';

const router = Router();

// /student/lecture-time  (view only)
router.get('/', studentLectureTimePage);

export default router;

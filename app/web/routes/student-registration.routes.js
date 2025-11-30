// app/web/routes/student-registration.routes.js

import express from 'express';
import {
  showCourseRegistrationPage,
  apiFindCourseByCode,
  apiListRegistrations,
  apiAddCourse,
  apiRemoveCourse,
  apiFinishRegistration,
  showCourseFormPrint,
} from '../controllers/studentRegistration.controller.js';

const router = express.Router();

// Page
router.get('/', showCourseRegistrationPage);

// APIs for AJAX
router.get('/api/course', apiFindCourseByCode);
router.get('/api/list', apiListRegistrations);
router.post('/api/add', apiAddCourse);
router.post('/api/remove', apiRemoveCourse);
router.post('/api/finish', apiFinishRegistration);

// Printable course form
router.get('/print', showCourseFormPrint);

export default router;

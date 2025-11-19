// app/web/routes/assign-course.routes.js
import { Router } from 'express';
import {
  assignPage,
  assignCourse,
  fetchCourseByCode,
  fetchStaffList,
  unassignCourse
} from '../controllers/assignCourse.controller.js';

import { requireRole } from '../../core/session.js';

const router = Router();

// -------------------------------------------------------------
// Layout + access control
// -------------------------------------------------------------
router.use((req, res, next) => {
  res.locals.layout = 'layouts/adminlte';
  next();
});

router.use(requireRole('admin', 'hod', 'registry', 'dean'));

// -------------------------------------------------------------
// Main pages
// -------------------------------------------------------------
router.get('/assign', assignPage);
router.post('/assign', assignCourse);

// -------------------------------------------------------------
// Ajax endpoints
// -------------------------------------------------------------
router.get('/api/fetch-course', fetchCourseByCode);
router.get('/api/fetch-staff', fetchStaffList);

// -------------------------------------------------------------
// Unassign
// -------------------------------------------------------------
router.post('/unassign/:id', unassignCourse);

export default router;

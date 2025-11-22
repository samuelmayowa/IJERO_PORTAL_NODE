// app/web/routes/view-assigned-courses.routes.js

import { Router } from 'express';
import { viewAssignedCoursesPage } from '../controllers/viewAssignedCourses.controller.js';

const router = Router();

// NO requireRole here – everyone with staff session can reach it.
router.get('/assigned', viewAssignedCoursesPage);

export default router;

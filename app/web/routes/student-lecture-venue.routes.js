// app/web/routes/student-lecture-venue.routes.js

import { Router } from 'express';
import {
  showVenuePage,
  saveVenue,
  deleteVenue,
} from '../controllers/studentLectureVenue.controller.js';

const router = Router();

// All under /staff/attendance/...
router.get('/student-venue', showVenuePage);
router.post('/student-venue', saveVenue);
router.post('/student-venue/:id/delete', deleteVenue);

export default router;

// app/web/routes/course-registration-report.routes.js

import { Router } from 'express';
import {
  listPage,
  fetchData,
  exportCsv,
} from '../controllers/course-registration-report.controller.js';

const router = Router();

// Page
router.get('/staff/registration/report', listPage);

// Data (AJAX)
router.get('/staff/registration/report/data', fetchData);

// Export (respects current filters via querystring)
router.get('/staff/registration/report/export.csv', exportCsv);

export default router;

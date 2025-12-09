// app/web/routes/student-attendance-report.routes.js
import { Router } from 'express';
import {
  listPage,
  fetchData,
  exportCsv,
  exportXlsx,
  exportPdf,
} from '../controllers/studentAttendanceReport.controller.js';

const router = Router();

// Page
router.get('/staff/student-attendance/report', listPage);

// Data (AJAX)
router.get('/staff/student-attendance/report/data', fetchData);

// Exports (respect current filters via querystring)
router.get('/staff/student-attendance/report/export.csv', exportCsv);
router.get('/staff/student-attendance/report/export.xlsx', exportXlsx);
router.get('/staff/student-attendance/report/export.pdf', exportPdf);

export default router;

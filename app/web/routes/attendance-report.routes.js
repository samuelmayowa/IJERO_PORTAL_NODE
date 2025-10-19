import { Router } from 'express';
import {
  listPage,
  fetchData,
  exportCsv,
  exportXlsx,
  exportPdf,
} from '../controllers/attendance-report.controller.js';

const router = Router();

// Page
router.get('/staff/attendance/report', listPage);

// Data (AJAX)
router.get('/staff/attendance/report/data', fetchData);

// Exports (respect current filters via querystring)
router.get('/staff/attendance/report/export.csv', exportCsv);
router.get('/staff/attendance/report/export.xlsx', exportXlsx);
router.get('/staff/attendance/report/export.pdf', exportPdf);

export default router;

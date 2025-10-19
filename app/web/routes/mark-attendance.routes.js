import express from 'express';
import {
  markAttendancePage,
  submitAttendance,
  checkoutAttendance
} from '../controllers/mark-attendance.controller.js'; // from web/routes -> web/controllers

const router = express.Router();

router.get('/mark', markAttendancePage);
router.post('/mark', submitAttendance);
router.post('/checkout', checkoutAttendance);

export default router;

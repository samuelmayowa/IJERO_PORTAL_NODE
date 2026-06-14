// app/web/routes/student.routes.js
import { Router } from 'express';
import {
  dashboard,
  uniformForm,
  saveUniform,
  uniformPrint,
} from '../controllers/student.controller.js';
import { requireStudent, studentPaymentHistory } from '../controllers/auth.controller.js';
import {
  examClearancePage,
  examClearancePdf,
  verifyExamClearance,
  examClearanceException,
} from '../controllers/examClearance.controller.js';

const router = Router();

// Dashboard (mounted at /student)
router.get('/', dashboard);

// ✅ Alias for /student/dashboard (so both URLs work)
router.get('/dashboard', dashboard);

// Uniform measurement
router.get('/uniform', uniformForm);
router.post('/uniform', saveUniform);
router.get('/uniform/print', uniformPrint);

// Student payment history
router.get('/payments/history', requireStudent, studentPaymentHistory);

// Exam clearance
router.get('/exams/clearance', requireStudent, examClearancePage);
router.get('/exams/clearance/print', requireStudent, examClearancePage);
router.get('/exams/clearance/pdf', requireStudent, examClearancePdf);
router.get('/exams/clearance/exception', requireStudent, examClearanceException);

// Public QR verification for exam clearance
router.get('/exams/clearance/verify/:token', verifyExamClearance);

export default router;

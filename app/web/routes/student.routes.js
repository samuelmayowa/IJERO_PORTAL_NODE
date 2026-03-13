// app/web/routes/student.routes.js
import { Router } from 'express';
import {
  dashboard,
  uniformForm,
  saveUniform,
  uniformPrint,
} from '../controllers/student.controller.js';
import { requireStudent, studentPaymentHistory } from '../controllers/auth.controller.js';

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

export default router;

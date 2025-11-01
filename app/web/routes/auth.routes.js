// app/web/routes/auth.routes.js
import { Router } from 'express';
import { getLogin, postLogin, logout } from '../controllers/auth.controller.js';
import {
  showRegister, postRegister,
  showStudentReset, postStudentReset,
  studentDashboard, applicantDashboard,
  requireStudent, requireApplicant
} from '../controllers/auth.controller.js';


const router = Router();

// login
router.get('/login', getLogin);
router.post('/login', postLogin);

// logout — support BOTH GET and POST (your form posts; some users might hit URL directly)
router.get('/logout', logout);
router.post('/logout', logout);

// Public register + student reset
router.get('/register', showRegister);
router.post('/register', postRegister);

router.get('/student/reset', showStudentReset);
router.post('/student/reset', postStudentReset);

// Public dashboards (protected by public session, not staff guard)
router.get('/student/dashboard', requireStudent, studentDashboard);
router.get('/applicant/dashboard', requireApplicant, applicantDashboard);


export default router;

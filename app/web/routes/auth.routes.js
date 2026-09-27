// app/web/routes/auth.routes.js
import { Router } from 'express';
import { getLogin, postLogin, logout } from '../controllers/auth.controller.js';
import { verifyExamClearance } from '../controllers/examClearance.controller.js';
import { verifyDocument as verifyAdmissionDocument, sampleDocumentVerification } from '../controllers/applicantAdmission.controller.js';
import {
  showRegister,
  postRegister,
  showStudentReset,
  postStudentReset,
  studentDashboard,
  applicantDashboard,
  requireStudent,
  requireApplicant,
  studentLookup, // NEW: AJAX student lookup
  portalChooser,
  switchPortal,
} from '../controllers/auth.controller.js';

const router = Router();

// Public exam clearance QR verification
router.get('/verify/exam-clearance/:token', verifyExamClearance);
router.get('/verify/admission-document/sample', sampleDocumentVerification);
router.get('/verify/admission-document/:token', verifyAdmissionDocument);

// login
router.get('/login', getLogin);
router.post('/login', postLogin);

// logout — support BOTH GET and POST (your form posts; some users might hit URL directly)
router.get('/logout', logout);
router.post('/logout', logout);

// Public register + student reset
router.get('/register', showRegister);
router.post('/register', postRegister);

// AJAX lookup for student details (email + access code from public_users)
router.post('/register/student-lookup', studentLookup);

router.get('/student/reset', showStudentReset);
router.post('/student/reset', postStudentReset);

// Public dashboards (protected by public session, not staff guard)
router.get('/student/dashboard', requireStudent, studentDashboard);
router.get('/applicant/dashboard', requireApplicant, applicantDashboard);
router.get('/portal/choose', portalChooser);
router.post('/portal/switch/:role', switchPortal);

export default router;

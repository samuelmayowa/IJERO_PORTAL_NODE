// app/web/routes/student.routes.js
import { Router } from 'express';
import * as student from '../controllers/student.controller.js';
import { requireRole, requireModule, blockIfReadOnly } from '../../core/session.js';
import { STUDENT_MODULES } from '../../core/status-policy.js';

const router = Router();

// All student pages require the student role
router.use(requireRole('student'));

// Dashboard: always allowed (just shows what's relevant)
// If you later want to restrict content inside, do it in the controller with res.locals.readOnly
router.get('/dashboard', student.dashboard);

/**
 * EXAMPLES — add your student endpoints here, guarded by modules:
 *
 * // Course Registration (blocked for GRADUATED)
 * router.get('/registration', requireModule(STUDENT_MODULES.REGISTRATION), student.showRegistration);
 * router.post('/registration', requireModule(STUDENT_MODULES.REGISTRATION), blockIfReadOnly('Register Course'), student.saveRegistration);
 *
 * // Fees (blocked for GRADUATED)
 * router.get('/fees/school', requireModule(STUDENT_MODULES.FEES), student.feesSchool);
 * router.post('/fees/pay', requireModule(STUDENT_MODULES.FEES), blockIfReadOnly('Pay Fees'), student.payFees);
 *
 * // Utilities (blocked for GRADUATED)
 * router.get('/rrr/track', requireModule(STUDENT_MODULES.UTILITIES), student.trackRRR);
 *
 * // Results/Transcripts (ALLOWED for GRADUATED)
 * router.get('/check-result', requireModule(STUDENT_MODULES.RESULTS), student.checkResult);
 * router.get('/academic-record', requireModule(STUDENT_MODULES.RESULTS), student.academicRecord);
 * router.get('/request-transcript', requireModule(STUDENT_MODULES.RESULTS), student.requestTranscript);
 * router.get('/current-gcpa', requireModule(STUDENT_MODULES.RESULTS), student.currentGCPA);
 */

export default router;

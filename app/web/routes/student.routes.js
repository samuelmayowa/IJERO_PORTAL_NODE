// app/web/routes/student.routes.js
import { Router } from 'express';
import * as student from '../controllers/student.controller.js';
import { requireRole } from '../../core/session.js';

const router = Router();

// Scope auth to the pages that truly need it
router.get('/dashboard', requireRole('student'), student.dashboard);

// Uniform Measurement (no forced logout)
router.get('/uniform', student.uniformForm);
router.post('/uniform', student.saveUniform);

// Printable PDF-friendly page
router.get('/uniform/print', student.uniformPrint);

export default router;

import { Router } from 'express';
import * as applicant from '../controllers/applicant.controller.js';

const router = Router();

// Dashboard
router.get('/dashboard', applicant.dashboard);

// Uniform Measurement
router.get('/uniform', applicant.uniformForm);
router.post('/uniform', applicant.saveUniform);
router.get('/uniform/print', applicant.uniformPrint);


export default router;

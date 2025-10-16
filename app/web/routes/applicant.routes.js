import { Router } from 'express';
import * as applicant from '../controllers/applicant.controller.js';

const router = Router();
router.get('/dashboard', applicant.dashboard);
export default router;

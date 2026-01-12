// app/web/routes/student-results.routes.js
import { Router } from 'express';
import {
  showSemesterResultPage,
  apiGetSemesterResults,
  printSemesterResultSlip,
} from '../controllers/student-results.controller.js';

const router = Router();

router.get('/semester', showSemesterResultPage);
router.get('/semester/api', apiGetSemesterResults);
router.get('/semester/print', printSemesterResultSlip);

export default router;

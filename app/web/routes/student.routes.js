// app/web/routes/student.routes.js
import { Router } from 'express';
import {
  dashboard,
  uniformForm,
  saveUniform,
  uniformPrint,
} from '../controllers/student.controller.js';

const router = Router();

// Dashboard (mounted at /student in server.js)
router.get('/', dashboard);

// Uniform measurement
router.get('/uniform', uniformForm);
router.post('/uniform', saveUniform);
router.get('/uniform/print', uniformPrint);

export default router;

// app/web/routes/semester.routes.js
import express from 'express';
import { showSemester, updateSemester, apiSetSemester } from '../controllers/semester.controller.js';

const router = express.Router();

router.get('/', showSemester);
router.post('/', updateSemester);
router.post('/api/set', apiSetSemester);

export default router;

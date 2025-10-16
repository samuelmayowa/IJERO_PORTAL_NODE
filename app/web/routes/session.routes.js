// app/web/routes/session.routes.js
import express from 'express';
import {
  showSetCurrentSession,
  setSession,
  showSwitchSemester,
  setSemester,
  apiSetSession,
  apiSetSemester,
  apiSwitchBack,
} from '../controllers/session.controller.js';

const router = express.Router();

// Pages
router.get('/current', showSetCurrentSession);
router.post('/current', setSession);

router.get('/semester', showSwitchSemester);
router.post('/semester', setSemester);

// JSON APIs
router.post('/api/set-session', apiSetSession);
// keep the alias your view calls:
router.post('/api/semester',    apiSetSemester);
router.post('/api/set-semester', apiSetSemester);

router.post('/api/switch-back', apiSwitchBack);

export default router;

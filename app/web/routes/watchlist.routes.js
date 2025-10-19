import { Router } from 'express';
import {
  page,
  data,
  history,
  addManual,
  removeManual,
} from '../controllers/watchlist.controller.js';

const router = Router();

// Page
router.get('/staff/attendance/watchlist', page);

// Data (AJAX)
router.get('/staff/attendance/watchlist/data', data);

// Per-staff recent history (AJAX)
router.get('/staff/attendance/watchlist/history', history);

// Manual add/update & remove
router.post('/staff/attendance/watchlist/manual/add', addManual);
router.post('/staff/attendance/watchlist/manual/remove', removeManual);

export default router;

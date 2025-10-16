// app/web/routes/staff.routes.js
import { Router } from 'express';
import * as staff from '../controllers/staff.controller.js';

const router = Router();

// Always use AdminLTE layout for staff area
router.use((req, res, next) => { 
  res.locals.layout = 'layouts/adminlte'; 
  next(); 
});

// NEW: hit /staff → redirect to /staff/dashboard
router.get('/', (_req, res) => res.redirect('/staff/dashboard'));

// Existing dashboard page
router.get('/dashboard', staff.dashboard);

export default router;

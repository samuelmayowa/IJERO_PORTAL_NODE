// app/web/routes/attendance.routes.js
import express from 'express';
import { requireRole } from '../../core/session.js';
import {
  viewOfficeLocationForm,
  saveOfficeLocation,
  apiDepartmentsBySchool,
  apiUpdateOfficeLocation,
  apiDeleteOfficeLocation
} from '../controllers/attendance.controller.js';

const router = express.Router();

// Views
router.get('/office-location', requireRole('admin', 'staff'), viewOfficeLocationForm);
router.post('/office-location', requireRole('admin', 'staff'), saveOfficeLocation);

// AJAX
router.get('/api/departments/by-school/:schoolId', requireRole('admin', 'staff'), apiDepartmentsBySchool);
router.post('/api/office-location/update', requireRole('admin', 'staff'), apiUpdateOfficeLocation);
router.post('/api/office-location/:id/delete', requireRole('admin', 'staff'), apiDeleteOfficeLocation);

export default router;

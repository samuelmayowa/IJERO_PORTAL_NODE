import { Router } from 'express';
import { can } from '../../core/rbac.js';
import * as ctrl from '../controllers/academic-records.controller.js';
const router = Router();
router.get('/', can('records.view'), ctrl.index);
router.get('/student/:id', can('records.view'), ctrl.studentRecord);
export default router;
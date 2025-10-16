import { Router } from 'express';
import { can } from '../../core/rbac.js';
import * as ctrl from '../controllers/results.controller.js';
const router = Router();
router.get('/', can('results.view'), ctrl.index);
router.get('/compute', can('results.compute'), ctrl.computeForm);
router.post('/compute', can('results.compute'), ctrl.computeSubmit);
export default router;
// app/web/routes/results-upload.routes.js
import { Router } from 'express';
import multer from 'multer';
import {
  showUploadPage,
  apiFetchCourse,
  apiUploadResults,
  downloadRejectionsCsv,
} from '../controllers/results-upload.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

router.get('/', showUploadPage);
router.get('/api/course', apiFetchCourse);
router.post('/api/upload', upload.single('file'), apiUploadResults);
router.get('/rejections/:batchId.csv', downloadRejectionsCsv);

export default router;

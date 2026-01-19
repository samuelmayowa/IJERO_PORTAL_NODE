import express from "express";
import multer from "multer";

import {
  showUploadPage,
  apiDepartmentsBySchool,
  apiProgrammesByDepartment,
  apiAssignedCourses,
  apiFetchCourse,
  downloadUploadTemplate,
  apiUploadResults,
  downloadRejectionsCsv,
} from "../controllers/results-upload.controller.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Page
router.get("/", showUploadPage);

// Template
router.get("/download-template", downloadUploadTemplate);

// APIs
router.get("/api/departments", apiDepartmentsBySchool);
router.get("/api/programmes", apiProgrammesByDepartment);
router.get("/api/assigned-courses", apiAssignedCourses);
router.get("/api/course", apiFetchCourse);

router.post("/api/upload", upload.single("file"), apiUploadResults);

router.get("/api/rejections/:resultBatchId.csv", downloadRejectionsCsv);

export default router;

// app/web/routes/vacancy.routes.js
import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  showVacancyForm,
  submitVacancyApplication,
} from "../controllers/vacancy.controller.js";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, "../../uploads/vacancies");

fs.mkdirSync(uploadDir, { recursive: true });

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
]);

const allowedExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".jpg",
  ".jpeg",
  ".png",
]);

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeBase = path
      .basename(file.originalname || "file", ext)
      .replace(/[^a-zA-Z0-9-_]/g, "_")
      .slice(0, 50);

    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${safeBase}-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB each
    files: 7,
  },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isMimeAllowed = allowedMimeTypes.has(file.mimetype);
    const isExtAllowed = allowedExtensions.has(ext);

    if (!isMimeAllowed && !isExtAllowed) {
      return cb(
        new Error("Only PDF, DOC, DOCX, JPG, JPEG, and PNG files are allowed."),
      );
    }

    return cb(null, true);
  },
});

const uploadFieldsMiddleware = (req, res, next) => {
  upload.fields([
    { name: "cv", maxCount: 1 },
    { name: "other_document", maxCount: 1 },
    { name: "certificates", maxCount: 5 },
  ])(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          ok: false,
          message: "Each uploaded file must be 5MB or less.",
        });
      }

      return res.status(400).json({
        ok: false,
        message: err.message || "File upload failed.",
      });
    }

    return res.status(400).json({
      ok: false,
      message: err.message || "Invalid file upload.",
    });
  });
};

// Public routes - no login required
router.get("/vacancies", showVacancyForm);
router.post(
  "/vacancies/apply",
  uploadFieldsMiddleware,
  submitVacancyApplication,
);

export default router;

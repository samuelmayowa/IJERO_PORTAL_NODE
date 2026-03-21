// app/web/routes/staff/vacancy-report.routes.js
import { Router } from "express";
import {
  index,
  exportCsv,
  downloadFile,
} from "../../controllers/staffVacancyReport.controller.js";

const router = Router();

router.get("/report", index);
router.get("/report/export.csv", exportCsv);
router.get("/report/file/:id/:kind", downloadFile);

export default router;

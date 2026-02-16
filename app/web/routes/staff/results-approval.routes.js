// app/web/routes/staff/results-approval.routes.js
import express from "express";
import {
  viewApproveResults,
  apiListBatches,
  apiListCourses,
  apiTakeAction,
  viewBatchPreview,
} from "../../controllers/results-approval.controller.js";

const router = express.Router();

/**
 * Page
 */
router.get("/", viewApproveResults);

/**
 * APIs (keep stable names to match existing UI calls)
 */
router.get("/api/list", apiListBatches);

// backward-compatible alias (in case any older JS calls this)
router.get("/api/batches", apiListBatches);

router.get("/api/courses", apiListCourses);

router.post("/api/action", apiTakeAction);

/**
 * View / preview page (scrollable)
 */
router.get("/view", viewBatchPreview);

export default router;

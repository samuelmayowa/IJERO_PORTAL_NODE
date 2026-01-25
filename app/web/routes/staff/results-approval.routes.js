import express from "express";
import {
  viewApproveResults,
  apiListBatches,
  apiTakeAction,
} from "../../controllers/results-approval.controller.js";

const router = express.Router();

router.get("/", viewApproveResults);
router.get("/api/batches", apiListBatches);
router.post("/api/action", apiTakeAction);

export default router;

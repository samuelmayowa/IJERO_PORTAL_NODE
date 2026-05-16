import { Router } from "express";
import { blockIfReadOnly, requireRole } from "../../../core/session.js";
import * as ctrl from "../../controllers/legacyPaymentRecovery.controller.js";

const router = Router();

router.use((req, res, next) => {
  res.locals.layout = "layouts/adminlte";
  next();
});

router.get(
  "/payments/legacy-recovery",
  requireRole("admin", "bursary", "staff"),
  ctrl.page,
);

router.get(
  "/api/payments/legacy-recovery/preview",
  requireRole("admin", "bursary", "staff"),
  ctrl.preview,
);

router.post(
  "/api/payments/legacy-recovery/import",
  requireRole("admin", "bursary", "staff"),
  blockIfReadOnly("Legacy Payment Recovery"),
  ctrl.importPayments,
);

export default router;

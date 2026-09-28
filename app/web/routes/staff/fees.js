// app/web/routes/staff/fees.js  (ESM)
// This router is mounted by server.js at: app.use('/staff/fees', feesRoutes)

import { Router } from "express";
import multer from "multer";
import * as pt from "../../controllers/paymentTypeController.js";
import * as gp from "../../controllers/generalPaymentController.js";
import * as applicationPaymentReportCtrl from "../../controllers/applicationPaymentReports.controller.js";
import * as balancesCtrl from "../../controllers/debtorsCreditors.controller.js";
import db from "../../../core/db.js";
import {
  listLatePaymentCharges,
  createLatePaymentCharge,
  editLatePaymentCharge,
  updateLatePaymentCharge,
  toggleLatePaymentCharge,
} from "../../controllers/latePaymentChargeController.js";


import {
  listApplicationForms,
  createApplicationForm,
  editApplicationForm,
  updateApplicationForm,
  setApplicationFormStatus,
} from "../../controllers/applicationFormController.js";

import {
  downloadPrerequisiteTemplate,
  uploadPrerequisites,
} from "../../controllers/applicationPrerequisiteController.js";
import { requireRole } from "../../../core/session.js";

const r = Router();
const adminOnly = requireRole("admin", "superadmin", "administrator");
const financeRoles = requireRole(
  "admin", "superadmin", "administrator", "registry", "bursary",
);
const balanceReportRoles = requireRole("admin", "superadmin", "administrator", "bursary", "bursar");
const admissionRoles = requireRole(
  "admin", "superadmin", "administrator", "registry", "admission officer",
);
const applicationFormRoles=requireRole("admin","superadmin","administrator","bursary","bursar");
const prerequisiteUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, callback) => {
    const filename = String(file.originalname || "").toLowerCase();
    const allowed =
      filename.endsWith(".csv") ||
      filename.endsWith(".xlsx") ||
      filename.endsWith(".xls");

    if (!allowed) {
      return callback(
        new Error("Only CSV or Excel prerequisite files are allowed."),
      );
    }

    callback(null, true);
  },
});


r.use((req, res, next) => {
  res.locals.layout = "layouts/adminlte";
  next();
});

// Payment Types
r.get("/payment-types", financeRoles, pt.index);
r.get("/payment-types/add", adminOnly, pt.addForm);
r.post("/payment-types/add", adminOnly, pt.create);
r.get("/payment-types/:id/edit", adminOnly, pt.editForm);
r.post("/payment-types/:id/edit", adminOnly, pt.update);

// Admin – All / General Payment
r.get("/payments", financeRoles, gp.index);
r.get("/payments/export.csv", financeRoles, gp.exportCsv);
r.get("/payments/export.xlsx", financeRoles, gp.exportXlsx);
r.get("/payments/export.pdf", financeRoles, gp.exportPdf);
r.get("/debtors-creditors", balanceReportRoles, balancesCtrl.page);
r.get("/debtors-creditors/export/:format", balanceReportRoles, balancesCtrl.exportReport);

// Application and acceptance fee reports
r.get(
  "/application-fees/export.csv",
  financeRoles,
  applicationPaymentReportCtrl.exportApplicationFeesCsv,
);
r.get("/application-fees/export.xlsx", financeRoles, applicationPaymentReportCtrl.exportApplicationFeesXlsx);
r.get("/application-fees/export.pdf", financeRoles, applicationPaymentReportCtrl.exportApplicationFeesPdf);

r.get(
  "/application-fees",
  financeRoles,
  applicationPaymentReportCtrl.applicationFeesReport,
);

r.get(
  "/acceptance-fees/export.csv",
  financeRoles,
  applicationPaymentReportCtrl.exportAcceptanceFeesCsv,
);
r.get("/acceptance-fees/export.xlsx", financeRoles, applicationPaymentReportCtrl.exportAcceptanceFeesXlsx);
r.get("/acceptance-fees/export.pdf", financeRoles, applicationPaymentReportCtrl.exportAcceptanceFeesPdf);

r.get(
  "/acceptance-fees",
  financeRoles,
  applicationPaymentReportCtrl.acceptanceFeesReport,
);

// Cascading dropdown: departments by school
r.get("/api/schools/:id/departments", async (req, res, next) => {
  try {
    const q = await db.query(
      "SELECT id, name FROM departments WHERE school_id=? ORDER BY name ASC",
      [req.params.id],
    );
    const rows = Array.isArray(q) && Array.isArray(q[0]) ? q[0] : q;
    res.json(rows);
  } catch (e) {
    next(e);
  }
});
// Cascading dropdown: programmes by department
r.get("/api/departments/:id/programmes", async (req, res, next) => {
  try {
    const q = await db.query(
      "SELECT id, name, department_id, school_id FROM programmes WHERE department_id=? ORDER BY name ASC",
      [req.params.id],
    );
    const rows = Array.isArray(q) && Array.isArray(q[0]) ? q[0] : q;
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Fallback: programmes by school
r.get("/api/schools/:id/programmes", async (req, res, next) => {
  try {
    const q = await db.query(
      "SELECT id, name, department_id, school_id FROM programmes WHERE school_id=? ORDER BY name ASC",
      [req.params.id],
    );
    const rows = Array.isArray(q) && Array.isArray(q[0]) ? q[0] : q;
    res.json(rows);
  } catch (e) {
    next(e);
  }
});




r.get(
  "/application-forms/prerequisite-template.csv",
  admissionRoles,
  downloadPrerequisiteTemplate,
);

r.post(
  "/application-forms/:id/prerequisites/upload",
  admissionRoles,
  prerequisiteUpload.single("prerequisite_file"),
  uploadPrerequisites,
);

// Generic application portal form management - admin only
r.get("/application-forms", applicationFormRoles, listApplicationForms);
r.post("/application-forms", applicationFormRoles, createApplicationForm);
r.get("/application-forms/:id/edit", applicationFormRoles, editApplicationForm);
r.post("/application-forms/:id/update", applicationFormRoles, updateApplicationForm);
r.post("/application-forms/:id/status", applicationFormRoles, setApplicationFormStatus);

// Late payment charge rules - admin only, no student payable impact yet
r.get("/late-payment-charges", financeRoles, listLatePaymentCharges);
r.post("/late-payment-charges", adminOnly, createLatePaymentCharge);
r.get("/late-payment-charges/:id/edit", adminOnly, editLatePaymentCharge);
r.post("/late-payment-charges/:id/update", adminOnly, updateLatePaymentCharge);
r.post("/late-payment-charges/:id/toggle", adminOnly, toggleLatePaymentCharge);

export default r;

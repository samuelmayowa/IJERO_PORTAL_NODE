// app/web/routes/staff/fees.js  (ESM)
// This router is mounted by server.js at: app.use('/staff/fees', feesRoutes)

import { Router } from "express";
import multer from "multer";
import * as pt from "../../controllers/paymentTypeController.js";
import * as gp from "../../controllers/generalPaymentController.js";
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

const r = Router();
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
r.get("/payment-types", pt.index);
r.get("/payment-types/add", pt.addForm);
r.post("/payment-types/add", pt.create);
r.get("/payment-types/:id/edit", pt.editForm);
r.post("/payment-types/:id/edit", pt.update);

// Admin – All / General Payment
r.get("/payments", gp.index);
r.get("/payments/export.csv", gp.exportCsv);

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
  downloadPrerequisiteTemplate,
);

r.post(
  "/application-forms/:id/prerequisites/upload",
  prerequisiteUpload.single("prerequisite_file"),
  uploadPrerequisites,
);

// Generic application portal form management - admin only
r.get("/application-forms", listApplicationForms);
r.post("/application-forms", createApplicationForm);
r.get("/application-forms/:id/edit", editApplicationForm);
r.post("/application-forms/:id/update", updateApplicationForm);
r.post("/application-forms/:id/status", setApplicationFormStatus);

// Late payment charge rules - admin only, no student payable impact yet
r.get("/late-payment-charges", listLatePaymentCharges);
r.post("/late-payment-charges", createLatePaymentCharge);
r.get("/late-payment-charges/:id/edit", editLatePaymentCharge);
r.post("/late-payment-charges/:id/update", updateLatePaymentCharge);
r.post("/late-payment-charges/:id/toggle", toggleLatePaymentCharge);

export default r;

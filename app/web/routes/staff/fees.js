// app/web/routes/staff/fees.js  (ESM)
// This router is mounted by server.js at: app.use('/staff/fees', feesRoutes)

import { Router } from "express";
import * as pt from "../../controllers/paymentTypeController.js";
import * as gp from "../../controllers/generalPaymentController.js";
import db from "../../../core/db.js";

const r = Router();

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

export default r;

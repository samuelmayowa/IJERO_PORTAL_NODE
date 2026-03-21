// app/web/routes/staff/bursary-payment-verification.routes.js
import { Router } from "express";
import {
  renderVerifyPage,
  confirmPayment,
} from "../../controllers/bursaryPaymentVerification.controller.js";

const r = Router();

// keep old menu/path working
r.get("/verify-applicant", (_req, res) => {
  res.redirect("/staff/bursary/verify-student");
});

r.get("/verify-student", renderVerifyPage);
r.post("/verify-student/check", confirmPayment);

// old form/action safety
r.post("/verify-applicant/check", confirmPayment);

export default r;

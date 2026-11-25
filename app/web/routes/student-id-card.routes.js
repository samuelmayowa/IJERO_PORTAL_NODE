import { Router } from "express";
import { ADMIN_ID_CARD_ROLES } from "../../services/studentIdCardService.js";
import * as controller from "../controllers/studentIdCard.controller.js";

const router = Router();
const adminOnly = (req, res, next) => {
  const user = req.session?.user || req.session?.staff || req.session?.account || req.user;
  if (!user) return res.redirect("/login");
  const roles = new Set([user.role, ...(Array.isArray(user.roles) ? user.roles : [])].map((role) => String(role || "").toLowerCase()));
  if (ADMIN_ID_CARD_ROLES.some((role) => roles.has(role))) {
    req.user = user;
    return next();
  }
  return res.status(403).render("pages/denied", {
    title: "Access Denied",
    pageTitle: "ACCESS DENIED",
    reason: "Only administrators can manage or download student ID card QR codes.",
    homeHref: "/staff/dashboard",
  });
};

router.get("/verify/student/:code", controller.publicVerification);
router.get("/verify/student/:code/photo", controller.publicPhoto);
router.get("/staff/student-id-cards", adminOnly, controller.adminList);
router.get("/staff/student-id-cards/export.xlsx", adminOnly, controller.exportExcel);
router.post("/staff/student-id-cards/download-selected.zip", adminOnly, controller.downloadSelectedQrZip);
router.get("/staff/student-id-cards/download-all.zip", adminOnly, controller.downloadAllQrZip);
router.get("/staff/student-id-cards/:id", adminOnly, controller.adminCard);
router.get("/staff/student-id-cards/:id/qr.svg", adminOnly, controller.downloadQr);

export default router;

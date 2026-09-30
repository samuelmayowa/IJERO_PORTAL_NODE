// app/web/routes/staff.routes.js
import { Router } from "express";

// Existing controllers already in your app
import * as staffCtrl from "../controllers/staff.controller.js";
import * as uniformRpt from "../controllers/uniform.report.controller.js";

// Guards – be tolerant to different export names in app/core/session.js
import * as guard from "../../core/session.js";

// New controllers we added
import * as courseCtrl from "../controllers/course.controller.js";
import * as schoolCtrl from "../controllers/school.controller.js";
import * as departmentCtrl from "../controllers/department.controller.js";
import * as studentEditCtrl from "../controllers/studentEdit.controller.js";
import * as applicationReportCtrl from "../controllers/applicationReports.controller.js";
import * as admissionsCtrl from "../controllers/admissions.controller.js";
import * as applicantEditorCtrl from "../controllers/applicantEditor.controller.js";
import { uploadApplicationDocumentFile } from "../middleware/applicationDocumentUpload.js";
const router = Router();

/* ──────────────────────────────────────────────────────────
   Helpers: resolve guards & safe controller access
   ────────────────────────────────────────────────────────── */
const staffOnly =
  guard.staffOnly ||
  guard.requireStaff ||
  guard.ensureStaff ||
  ((req, _res, next) => next()); // last-resort passthrough to avoid 500s

const requireRole = (...roles) =>
  guard.requireRole ? guard.requireRole(...roles) : (req, _res, next) => next();
const admissionRoles = requireRole(
  "admin", "administrator", "superadmin",
  "registry", "registrary", "registrar",
  "admission officer", "admissions officer", "admission",
);

const safe = (fnName) => {
  const fn = staffCtrl?.[fnName];
  if (typeof fn === "function") return fn;
  return (_req, res) =>
    res
      .status(500)
      .send(
        `Controller "${fnName}" is not exported from app/web/controllers/staff.controller.js`,
      );
};

/* ──────────────────────────────────────────────────────────
   Layout + CSRF available on every staff page
   ────────────────────────────────────────────────────────── */
router.use((req, res, next) => {
  res.locals.layout = "layouts/adminlte";
  next();
});

router.use((req, res, next) => {
  try {
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : "";
  } catch {
    res.locals.csrfToken = "";
  }
  next();
});

/* ──────────────────────────────────────────────────────────
   Keep /staff redirect + Dashboard
   ────────────────────────────────────────────────────────── */
router.get("/", (_req, res) => res.redirect("/staff/dashboard"));
router.get("/dashboard", safe("dashboard"));

router.get(
  "/admissions/applications/export.csv",
  admissionRoles,
  applicationReportCtrl.exportApplicationsCsv,
);

router.get("/admissions/manage", admissionRoles, admissionsCtrl.managePage);
router.post("/admissions/:id/admit", admissionRoles, admissionsCtrl.admitOne);
router.post("/admissions/bulk-admit", admissionRoles, admissionsCtrl.admitBulk);
router.post("/admissions/:id/revoke", admissionRoles, admissionsCtrl.revokeOne);
router.get("/admissions/criteria", admissionRoles, admissionsCtrl.criteriaPage);
router.post("/admissions/criteria", admissionRoles, admissionsCtrl.createCriterion);
router.post("/admissions/criteria/:id/update", admissionRoles, admissionsCtrl.updateCriterion);
router.post("/admissions/criteria/:id/toggle", admissionRoles, admissionsCtrl.toggleCriterion);
router.post("/admissions/subjects", requireRole("admin", "registry"), admissionsCtrl.createSubject);
router.post("/admissions/subjects/:id/toggle", requireRole("admin", "registry"), admissionsCtrl.toggleSubject);
router.get("/admissions/screening", admissionRoles, admissionsCtrl.screeningPage);
router.post("/admissions/screening", admissionRoles, admissionsCtrl.createScreening);
router.post("/admissions/screening/:id/update", admissionRoles, admissionsCtrl.updateScreening);
router.post("/admissions/screening/:id/status", admissionRoles, admissionsCtrl.changeScreeningStatus);
router.get("/admissions/settings", requireRole("admin"), admissionsCtrl.settingsPage);
router.post("/admissions/settings", requireRole("admin"), admissionsCtrl.saveSettings);
router.get("/admissions/matriculation", admissionRoles, admissionsCtrl.matriculationPage);
router.post("/admissions/matriculation/:applicationId/generate", admissionRoles, admissionsCtrl.generateMatric);
router.post("/admissions/matriculation/bulk", admissionRoles, admissionsCtrl.generateMatricBulk);
router.get("/admissions/applicants/:id/edit", admissionRoles, applicantEditorCtrl.editPage);
router.post("/admissions/applicants/:id/edit", admissionRoles, applicantEditorCtrl.updateApplicant);
router.post("/admissions/applicants/:id/passport/:documentType", admissionRoles, uploadApplicationDocumentFile, applicantEditorCtrl.replacePassport);
router.get("/admissions/documents", admissionRoles, admissionsCtrl.templatesPage);
router.post("/admissions/documents/preview-draft", admissionRoles, admissionsCtrl.previewDraftTemplate);
router.post("/admissions/documents/sample-draft.pdf", admissionRoles, admissionsCtrl.sampleDraftTemplatePdf);
router.post("/admissions/documents", admissionRoles, admissionsCtrl.createTemplate);
router.post("/admissions/documents/:id/update", admissionRoles, admissionsCtrl.updateTemplate);
router.post("/admissions/documents/:id/publish", admissionRoles, admissionsCtrl.publishTemplate);
router.get("/admissions/documents/:id/preview", admissionRoles, admissionsCtrl.previewTemplate);
router.get("/admissions/documents/:id/attachment", admissionRoles, admissionsCtrl.templateAttachment);
router.get("/admissions/documents/:id/sample.pdf", admissionRoles, admissionsCtrl.sampleTemplatePdf);
router.get("/admissions/announcements", admissionRoles, admissionsCtrl.announcementsPage);
router.post("/admissions/announcements", admissionRoles, admissionsCtrl.createAnnouncement);
router.post("/admissions/announcements/:id/update", admissionRoles, admissionsCtrl.updateAnnouncement);
router.get("/admissions/notifications", admissionRoles, admissionsCtrl.notificationDeliveriesPage);
router.post("/admissions/notifications/:id/resend", admissionRoles, admissionsCtrl.resendNotification);

router.get(
  "/admissions/applications",
  admissionRoles,
  applicationReportCtrl.applicationsReport,
);





/* ───────────────────── Student Edit ───────────────────── */
router.get(
  "/students/edit",
  requireRole("admin", "registry"),
  studentEditCtrl.showStudentEditPage,
);
router.get(
  "/api/students",
  requireRole("admin", "registry"),
  studentEditCtrl.listStudents,
);
router.post(
  "/api/students/:id",
  requireRole("admin", "registry"),
  studentEditCtrl.updateStudent,
);

/* ───────────────── Password tools (existing) ────────────── */
router.get("/password-reset", safe("passwordResetPage"));
router.get("/api/password/users", safe("listUsersForPasswordReset"));
router.post("/api/password/reset/:id", safe("resetPasswordToCollege1"));
router.post("/api/password/change", safe("changePasswordByAdmin"));

/* ─────────────── Uniform Measurement Report ─────────────── */
router.get(
  "/uniform/report",
  requireRole("admin", "registry", "hod"),
  uniformRpt.page,
);
router.get(
  "/uniform/api/report",
  requireRole("admin", "registry", "hod"),
  uniformRpt.apiList,
);
router.get(
  "/uniform/api/export/csv",
  requireRole("admin", "registry", "hod"),
  uniformRpt.exportCsv,
);

// ----- Courses -----
router.get("/courses/add", courseCtrl.addPage);
router.get("/courses/departments", courseCtrl.listDepartmentsBySchool);

router.post("/courses/add", courseCtrl.addCourse);
router.post("/courses/:id/update", courseCtrl.updateCourse);
router.post("/courses/:id/delete", courseCtrl.deleteCourse);

/* ───────────────────── Schools (Manage) ─────────────────── */
// ----- Schools -----
router.get("/schools", schoolCtrl.managePage);
router.post("/schools/create", schoolCtrl.create);
router.post("/schools/:id/update", schoolCtrl.update);
router.post("/schools/:id/delete", schoolCtrl.remove);

// ----- Departments -----
router.get("/departments", departmentCtrl.managePage);
router.post("/departments/create", departmentCtrl.create);
router.post("/departments/:id/update", departmentCtrl.update);
router.post("/departments/:id/delete", departmentCtrl.remove);
router.post(
  "/departments/programmes/create",
  departmentCtrl.createProgramme,
);
router.post(
  "/departments/programmes/:id/delete",
  departmentCtrl.deleteProgramme,
);
router.get(
  "/departments/programmes",
  departmentCtrl.listProgrammesByDepartment,
);

export default router;

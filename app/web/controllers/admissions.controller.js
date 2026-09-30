import { pool } from "../../core/db.js";
import {
  admitApplication,
  evaluateEligibility,
  revokeAdmission,
} from "../../services/admissionService.js";
import {
  createPortalNotification,
  dispatchNotificationEmails,
} from "../../services/notificationService.js";
import { sendPendingEmail } from "../../services/notificationService.js";
import { writeAudit } from "../../services/auditService.js";
import { generateMatriculation } from "../../services/matriculationService.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import {
  PDFDocument as PDFLibDocument,
  StandardFonts,
  rgb,
} from "pdf-lib";

const clean = (value) => String(value ?? "").trim();
const id = (value) => Number.parseInt(value, 10) || 0;

async function options() {
  const [
    [sessions],
    [forms],
    [schools],
    [departments],
    [programmes],
    [subjects],
  ] = await Promise.all([
    pool.query(
      `SELECT id,name,is_current FROM sessions ORDER BY is_current DESC,id DESC`,
    ),
    pool.query(
      `SELECT id,title,session_id FROM application_forms ORDER BY id DESC`,
    ),
    pool.query(`SELECT id,name FROM schools ORDER BY name`),
    pool.query(`SELECT id,school_id,name FROM departments ORDER BY name`),
    pool.query(
      `SELECT id,school_id,department_id,name FROM programmes ORDER BY name`,
    ),
    pool.query(
      `SELECT id,name,is_active FROM admission_subject_catalogue ORDER BY name`,
    ),
  ]);
  return { sessions, forms, schools, departments, programmes, subjects };
}

export async function createSubject(req, res) {
  try {
    const name = clean(req.body.name).replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 120)
      throw new Error("Enter a valid subject name.");
    const normalized = name.toLowerCase();
    await pool.query(
      `INSERT INTO admission_subject_catalogue (name,normalized_name,created_by,updated_by) VALUES (?,?,?,?)`,
      [name, normalized, req.user?.id || null, req.user?.id || null],
    );
    await writeAudit(null, req, {
      action: "ADMISSION_SUBJECT_CREATED",
      entityType: "admission_subject",
      entityId: normalized,
      newValues: { name },
    });
    req.flash("success", `${name} added to the subject catalogue.`);
  } catch (error) {
    req.flash(
      "error",
      error.code === "ER_DUP_ENTRY"
        ? "That subject already exists."
        : error.message || "Unable to add subject.",
    );
  }
  res.redirect(req.get("referer") || "/staff/admissions/criteria");
}

export async function toggleSubject(req, res) {
  try {
    const subjectId = id(req.params.id);
    await pool.query(
      `UPDATE admission_subject_catalogue SET is_active=IF(is_active=1,0,1),updated_by=? WHERE id=?`,
      [req.user?.id || null, subjectId],
    );
    await writeAudit(null, req, {
      action: "ADMISSION_SUBJECT_TOGGLED",
      entityType: "admission_subject",
      entityId: subjectId,
    });
    req.flash("success", "Subject status updated.");
  } catch (error) {
    req.flash("error", error.message || "Unable to update subject.");
  }
  res.redirect(req.get("referer") || "/staff/admissions/criteria");
}

export async function criteriaPage(req, res, next) {
  try {
    const opts = await options();
    const sessionId =
      id(req.query.session_id) ||
      id(opts.sessions.find((row) => row.is_current)?.id) ||
      id(opts.sessions[0]?.id);
    const [rows] = await pool.query(
      `SELECT ac.*, s.name session_name, af.title application_title,
              sc.name school_name, d.name department_name, p.name programme_name,
              GROUP_CONCAT(CONCAT(acs.subject_name, ':', COALESCE(acs.minimum_grade,'C6')) ORDER BY acs.subject_name SEPARATOR ', ') required_subjects
         FROM admission_criteria ac
         JOIN sessions s ON s.id=ac.session_id
         LEFT JOIN application_forms af ON af.id=ac.application_form_id
         LEFT JOIN schools sc ON sc.id=ac.school_id
         LEFT JOIN departments d ON d.id=ac.department_id
         LEFT JOIN programmes p ON p.id=ac.programme_id
         LEFT JOIN admission_criterion_subjects acs ON acs.admission_criterion_id=ac.id AND acs.is_mandatory=1
        WHERE ac.session_id=? GROUP BY ac.id ORDER BY ac.id DESC`,
      [sessionId],
    );
    let editRow = null,
      editSubjects = [];
    const editId = id(req.query.edit);
    if (editId) {
      [[editRow]] = await pool.query(
        `SELECT * FROM admission_criteria WHERE id=? LIMIT 1`,
        [editId],
      );
      if (editRow)
        [editSubjects] = await pool.query(
          `SELECT * FROM admission_criterion_subjects WHERE admission_criterion_id=? ORDER BY id`,
          [editId],
        );
    }
    res.render("pages/staff/admission-criteria", {
      layout: "layouts/adminlte",
      title: "Admission Criteria",
      pageTitle: "Admission Criteria",
      ...opts,
      rows,
      sessionId,
      editRow,
      editSubjects,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCriterion(req, res) {
  const criterionId = id(req.params.id),
    reason = clean(req.body.reason);
  const connection = await pool.getConnection();
  try {
    if (!reason)
      throw new Error("A reason for changing admission criteria is required.");
    await connection.beginTransaction();
    const [[before]] = await connection.query(
      `SELECT * FROM admission_criteria WHERE id=? FOR UPDATE`,
      [criterionId],
    );
    if (!before) throw new Error("Criterion not found.");
    const scoreMode =
        clean(req.body.score_mode).toUpperCase() === "PERCENT"
          ? "PERCENT"
          : "RAW",
      minimumScore = clean(req.body.minimum_score),
      maximumScore = clean(req.body.maximum_score);
    if (scoreMode === "PERCENT" && (!maximumScore || Number(maximumScore) <= 0))
      throw new Error(
        "Maximum obtainable score is required for percentage criteria.",
      );
    await connection.query(
      `UPDATE admission_criteria SET application_form_id=?,school_id=?,department_id=?,programme_id=?,minimum_score=?,score_mode=?,maximum_score=?,score_required=?,minimum_olevel_credits=?,is_active=?,notes=?,updated_by=? WHERE id=?`,
      [
        id(req.body.application_form_id) || null,
        id(req.body.school_id) || null,
        id(req.body.department_id) || null,
        id(req.body.programme_id) || null,
        minimumScore === "" ? null : Number(minimumScore),
        scoreMode,
        maximumScore === "" ? null : Number(maximumScore),
        req.body.score_required ? 1 : 0,
        id(req.body.minimum_olevel_credits) || null,
        req.body.is_active ? 1 : 0,
        clean(req.body.notes) || null,
        req.user?.id || null,
        criterionId,
      ],
    );
    await connection.query(
      `DELETE FROM admission_criterion_subjects WHERE admission_criterion_id=?`,
      [criterionId],
    );
    const names = Array.isArray(req.body.subject_name)
        ? req.body.subject_name
        : [req.body.subject_name],
      grades = Array.isArray(req.body.minimum_grade)
        ? req.body.minimum_grade
        : [req.body.minimum_grade];
    for (let i = 0; i < names.length; i++) {
      const subject = clean(names[i]);
      if (subject)
        await connection.query(
          `INSERT INTO admission_criterion_subjects (admission_criterion_id,subject_name,minimum_grade,is_mandatory) VALUES (?,?,?,1)`,
          [criterionId, subject, clean(grades[i]) || "C6"],
        );
    }
    await writeAudit(connection, req, {
      action: "ADMISSION_CRITERION_UPDATED",
      entityType: "admission_criterion",
      entityId: criterionId,
      reason,
      oldValues: before,
      newValues: {
        minimum_score: minimumScore,
        score_mode: scoreMode,
        maximum_score: maximumScore,
      },
    });
    await connection.commit();
    req.flash("success", "Admission criterion updated.");
    res.redirect(`/staff/admissions/criteria?session_id=${before.session_id}`);
  } catch (error) {
    await connection.rollback();
    req.flash("error", error.message || "Unable to update criterion.");
    res.redirect(`/staff/admissions/criteria?edit=${criterionId}`);
  } finally {
    connection.release();
  }
}

export async function createCriterion(req, res, next) {
  const connection = await pool.getConnection();
  try {
    const sessionId = id(req.body.session_id);
    if (!sessionId) throw new Error("Academic session is required.");
    const minimumScore = clean(req.body.minimum_score);
    const scoreMode =
      clean(req.body.score_mode).toUpperCase() === "PERCENT"
        ? "PERCENT"
        : "RAW";
    const maximumScore = clean(req.body.maximum_score);
    if (
      minimumScore &&
      (Number.isNaN(Number(minimumScore)) ||
        Number(minimumScore) < 0 ||
        (scoreMode === "PERCENT" && Number(minimumScore) > 100))
    )
      throw new Error(
        "Enter a valid cut-off score; percentage cut-offs cannot exceed 100.",
      );
    if (scoreMode === "PERCENT" && (!maximumScore || Number(maximumScore) <= 0))
      throw new Error(
        "Maximum obtainable score is required for percentage criteria.",
      );
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO admission_criteria
       (session_id,application_form_id,school_id,department_id,programme_id,minimum_score,score_mode,maximum_score,score_required,minimum_olevel_credits,is_active,notes,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        sessionId,
        id(req.body.application_form_id) || null,
        id(req.body.school_id) || null,
        id(req.body.department_id) || null,
        id(req.body.programme_id) || null,
        minimumScore === "" ? null : Number(minimumScore),
        scoreMode,
        maximumScore === "" ? null : Number(maximumScore),
        req.body.score_required ? 1 : 0,
        id(req.body.minimum_olevel_credits) || null,
        req.body.is_active ? 1 : 0,
        clean(req.body.notes) || null,
        req.user?.id || null,
        req.user?.id || null,
      ],
    );
    const subjectNames = Array.isArray(req.body.subject_name)
      ? req.body.subject_name
      : [req.body.subject_name];
    const grades = Array.isArray(req.body.minimum_grade)
      ? req.body.minimum_grade
      : [req.body.minimum_grade];
    for (let index = 0; index < subjectNames.length; index += 1) {
      const subject = clean(subjectNames[index]);
      if (!subject) continue;
      await connection.query(
        `INSERT INTO admission_criterion_subjects (admission_criterion_id,subject_name,minimum_grade,is_mandatory) VALUES (?,?,?,1)`,
        [result.insertId, subject, clean(grades[index]) || "C6"],
      );
    }
    await writeAudit(connection, req, {
      action: "ADMISSION_CRITERION_CREATED",
      entityType: "admission_criterion",
      entityId: result.insertId,
      newValues: { session_id: sessionId, minimum_score: minimumScore },
    });
    await connection.commit();
    req.flash("success", "Admission criterion created successfully.");
    res.redirect(`/staff/admissions/criteria?session_id=${sessionId}`);
  } catch (error) {
    await connection.rollback();
    req.flash("error", error.message || "Unable to create criterion.");
    res.redirect("/staff/admissions/criteria");
  } finally {
    connection.release();
  }
}

export async function toggleCriterion(req, res, next) {
  try {
    const criterionId = id(req.params.id);
    const [[before]] = await pool.query(
      `SELECT * FROM admission_criteria WHERE id=? LIMIT 1`,
      [criterionId],
    );
    if (!before) return res.status(404).send("Criterion not found.");
    await pool.query(
      `UPDATE admission_criteria SET is_active=IF(is_active=1,0,1), updated_by=? WHERE id=?`,
      [req.user?.id || null, criterionId],
    );
    await writeAudit(null, req, {
      action: "ADMISSION_CRITERION_TOGGLED",
      entityType: "admission_criterion",
      entityId: criterionId,
      oldValues: { is_active: before.is_active },
      newValues: { is_active: before.is_active ? 0 : 1 },
    });
    res.redirect(`/staff/admissions/criteria?session_id=${before.session_id}`);
  } catch (error) {
    next(error);
  }
}

function filters(req, defaultSessionId) {
  return {
    sessionId: id(req.query.session_id) || defaultSessionId,
    formId: id(req.query.application_form_id),
    schoolId: id(req.query.school_id),
    departmentId: id(req.query.department_id),
    programmeId: id(req.query.programme_id),
    status: clean(req.query.status).toUpperCase(),
    q: clean(req.query.q).slice(0, 150),
    page: Math.max(1, id(req.query.page) || 1),
  };
}

export async function managePage(req, res, next) {
  try {
    const opts = await options();
    const currentSession =
      id(opts.sessions.find((row) => row.is_current)?.id) ||
      id(opts.sessions[0]?.id);
    const f = filters(req, currentSession);
    const clauses = ["af.session_id=?", "aa.submitted_at IS NOT NULL"];
    const params = [f.sessionId];
    if (f.formId) {
      clauses.push("aa.application_form_id=?");
      params.push(f.formId);
    }
    if (f.status) {
      clauses.push("aa.status=?");
      params.push(f.status);
    }
    if (f.schoolId) {
      clauses.push(
        `CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.school_id')) AS UNSIGNED)=?`,
      );
      params.push(f.schoolId);
    }
    if (f.departmentId) {
      clauses.push(
        `CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.department_id')) AS UNSIGNED)=?`,
      );
      params.push(f.departmentId);
    }
    if (f.programmeId) {
      clauses.push(
        `CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.programme_id')) AS UNSIGNED)=?`,
      );
      params.push(f.programmeId);
    }
    if (f.q) {
      clauses.push(
        `(aa.application_number LIKE ? OR CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) LIKE ? OR pu.username LIKE ? OR aa.programme_choice LIKE ?)`,
      );
      const term = `%${f.q}%`;
      params.push(term, term, term, term);
    }
    const where = clauses.join(" AND ");
    const [[summary]] = await pool.query(
      `SELECT COUNT(*) total_submitted,
       SUM(aa.status='ADMITTED') total_admitted,
       SUM(aa.acceptance_payment_status='PAID') acceptance_paid,
       SUM(ap.jamb_total_score IS NOT NULL) scores_uploaded
       FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id
       JOIN public_users pu ON pu.id=aa.applicant_user_id
       LEFT JOIN application_prerequisites ap ON ap.application_form_id=aa.application_form_id AND ap.matched_applicant_user_id=aa.applicant_user_id
       WHERE ${where}`,
      params,
    );
    const [rows] = await pool.query(
      `SELECT aa.id,aa.application_number,aa.programme_choice,aa.status,aa.acceptance_payment_status,aa.submitted_at,
       af.title application_title,s.name session_name,pu.first_name,pu.middle_name,pu.last_name,pu.username email,
       MAX(ap.jamb_total_score) entrance_score,ad.id decision_id,ad.status decision_status
       FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id
       JOIN sessions s ON s.id=af.session_id JOIN public_users pu ON pu.id=aa.applicant_user_id
       LEFT JOIN application_prerequisites ap ON ap.application_form_id=aa.application_form_id AND ap.matched_applicant_user_id=aa.applicant_user_id
       LEFT JOIN admission_decisions ad ON ad.applicant_application_id=aa.id
       WHERE ${where} GROUP BY aa.id ORDER BY aa.submitted_at DESC LIMIT 100`,
      params,
    );
    for (const row of rows) {
      const evaluation = await evaluateEligibility(row.id);
      row.eligible = evaluation.eligible;
      row.eligibility_reasons = evaluation.reasons;
    }
    res.render("pages/staff/admissions-manage", {
      layout: "layouts/adminlte",
      title: "Manage Admissions",
      pageTitle: "Manage Admissions",
      ...opts,
      filters: f,
      summary: summary || {},
      rows,
    });
  } catch (error) {
    next(error);
  }
}

export async function admitOne(req, res) {
  try {
    const result = await admitApplication(req, id(req.params.id), {
      override: req.body.override === "1",
      reason: req.body.reason,
    });
    if (result.notificationId)
      dispatchNotificationEmails(result.notificationId).catch((error) =>
        console.error("Admission email dispatch failed:", error.message),
      );
    req.flash(
      "success",
      result.existing
        ? "Applicant was already admitted."
        : "Admission issued successfully.",
    );
  } catch (error) {
    req.flash("error", error.message || "Admission could not be issued.");
  }
  res.redirect(req.get("referer") || "/staff/admissions/manage");
}

export async function admitBulk(req, res) {
  const ids = [
    ...new Set(
      (Array.isArray(req.body.application_ids)
        ? req.body.application_ids
        : [req.body.application_ids]
      )
        .map(id)
        .filter(Boolean),
    ),
  ].slice(0, 250);
  const results = [];
  for (const applicationId of ids) {
    try {
      const result = await admitApplication(req, applicationId, {});
      results.push({ applicationId, ok: true, existing: result.existing });
      if (result.notificationId)
        dispatchNotificationEmails(result.notificationId).catch(() => {});
    } catch (error) {
      results.push({ applicationId, ok: false, error: error.message });
    }
  }
  const succeeded = results.filter((row) => row.ok).length;
  const failed = results.length - succeeded;
  req.flash(
    failed ? "error" : "success",
    `${succeeded} application(s) processed successfully; ${failed} skipped.`,
  );
  res.redirect("/staff/admissions/manage");
}

export async function revokeOne(req, res) {
  try {
    const result = await revokeAdmission(
      req,
      id(req.params.id),
      req.body.reason,
    );
    if (result.notificationId)
      dispatchNotificationEmails(result.notificationId).catch(() => {});
    req.flash(
      "success",
      "Admission revoked. No automatic refund was created; any applicable refund must be handled manually by the Bursary.",
    );
  } catch (error) {
    req.flash("error", error.message || "Admission could not be revoked.");
  }
  res.redirect(req.get("referer") || "/staff/admissions/manage");
}

export async function settingsPage(req, res, next) {
  try {
    const opts = await options();
    const requestedSessionId = id(req.query.session_id);
    const currentSessionId =
      id(opts.sessions.find((row) => row.is_current)?.id) ||
      id(opts.sessions[0]?.id);
    const sessionId =
      requestedSessionId ||
      (opts.forms.some((form) => id(form.session_id) === currentSessionId)
        ? currentSessionId
        : id(opts.forms[0]?.session_id) || currentSessionId);
    const [rows] = await pool.query(
      `SELECT ast.*,af.title application_title,s.name session_name FROM admission_settings ast
       JOIN sessions s ON s.id=ast.session_id LEFT JOIN application_forms af ON af.id=ast.application_form_id
       WHERE ast.session_id=? ORDER BY ast.application_form_id IS NULL DESC,af.title`,
      [sessionId],
    );
    res.render("pages/staff/admission-settings", {
      layout: "layouts/adminlte",
      title: "Admission Settings",
      pageTitle: "Admission Settings",
      ...opts,
      sessionId,
      rows,
    });
  } catch (error) {
    next(error);
  }
}

export async function saveSettings(req, res) {
  try {
    const sessionId = id(req.body.session_id),
      formId = id(req.body.application_form_id) || null;
    if (!sessionId) throw new Error("Academic session is required.");
    const registrarName = clean(req.body.registrar_name) || null;
    const registrarPosition = clean(req.body.registrar_position) || "Registrar";
    let signaturePath = null;
    if (req.file) {
      const signature = req.file.buffer.subarray(0, 8).toString("hex");
      const isPng = signature === "89504e470d0a1a0a",
        isJpeg = signature.startsWith("ffd8ff");
      if (!isPng && !isJpeg)
        throw new Error(
          "Registrar signature must be a genuine PNG or JPEG file.",
        );
      const directory = path.resolve(
        "app/web/public/uploads/admission-settings",
      );
      await fs.mkdir(directory, { recursive: true });
      const filename = `registrar-signature-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${isPng ? "png" : "jpg"}`;
      await fs.writeFile(path.join(directory, filename), req.file.buffer, {
        flag: "wx",
      });
      signaturePath = `/public/uploads/admission-settings/${filename}`;
    }
    await pool.query(
      `INSERT INTO admission_settings (session_id,application_form_id,acceptance_required_for_letter,matriculation_enabled,registrar_name,registrar_position,registrar_signature_path,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE acceptance_required_for_letter=VALUES(acceptance_required_for_letter),
       matriculation_enabled=VALUES(matriculation_enabled),registrar_name=VALUES(registrar_name),registrar_position=VALUES(registrar_position),
       registrar_signature_path=COALESCE(VALUES(registrar_signature_path),registrar_signature_path),updated_by=VALUES(updated_by)`,
      [
        sessionId,
        formId,
        req.body.acceptance_required_for_letter ? 1 : 0,
        req.body.matriculation_enabled ? 1 : 0,
        registrarName,
        registrarPosition,
        signaturePath,
        req.user?.id || null,
        req.user?.id || null,
      ],
    );
    await writeAudit(null, req, {
      action: "ADMISSION_SETTINGS_UPDATED",
      entityType: "admission_settings",
      entityId: `${sessionId}:${formId || "default"}`,
      newValues: {
        acceptance_required_for_letter: Boolean(
          req.body.acceptance_required_for_letter,
        ),
        matriculation_enabled: Boolean(req.body.matriculation_enabled),
        registrar_name: registrarName,
        registrar_position: registrarPosition,
        signature_updated: Boolean(signaturePath),
      },
    });
    req.flash("success", "Admission and matriculation settings saved.");
  } catch (error) {
    req.flash("error", error.message || "Unable to save admission settings.");
  }
  res.redirect(
    `/staff/admissions/settings?session_id=${id(req.body.session_id)}`,
  );
}

export async function matriculationPage(req, res, next) {
  try {
    const opts = await options();
    const sessionId =
      id(req.query.session_id) ||
      id(opts.sessions.find((x) => x.is_current)?.id) ||
      id(opts.sessions[0]?.id);
    const [rows] = await pool.query(
      `SELECT aa.id applicant_application_id,aa.application_number,aa.status application_status,aa.acceptance_payment_status,pu.id public_user_id,pu.first_name,pu.middle_name,pu.last_name,pu.username email,pu.matric_number,ad.id admission_decision_id,ad.status decision_status,ad.offered_programme_name,d.name department_name,d.code department_code,p.name programme_name,t.id transition_id,t.status transition_status,t.compulsory_invoice_id,ma.sequence_number,ma.assigned_at FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN public_users pu ON pu.id=aa.applicant_user_id LEFT JOIN admission_decisions ad ON ad.applicant_application_id=aa.id AND ad.status='ADMITTED' LEFT JOIN applicant_student_transitions t ON t.applicant_application_id=aa.id LEFT JOIN departments d ON d.id=ad.offered_department_id LEFT JOIN programmes p ON p.id=ad.offered_programme_id LEFT JOIN matric_number_assignments ma ON ma.applicant_application_id=aa.id WHERE af.session_id=? AND (aa.acceptance_payment_status='PAID' OR t.id IS NOT NULL) ORDER BY (ma.assigned_at IS NULL) DESC,COALESCE(ma.assigned_at,t.created_at,aa.updated_at) DESC`,
      [sessionId],
    );
    for (const row of rows) {
      row.generation_ready = Boolean(
        row.admission_decision_id &&
          row.transition_id &&
          !row.matric_number &&
          row.department_code,
      );
      row.lifecycle_status = row.matric_number
        ? "GENERATED"
        : !row.admission_decision_id
          ? "AWAITING_ADMISSION"
          : !row.transition_id
            ? "AWAITING_COMPULSORY_FEE"
            : !row.department_code
              ? "MISSING_DEPARTMENT_CODE"
              : "READY_TO_GENERATE";
    }
    const [[sequence]] = await pool.query(
      `SELECT last_number,updated_at FROM matric_number_sequences WHERE session_id=?`,
      [sessionId],
    );
    res.render("pages/staff/matriculation-numbers", {
      layout: "layouts/adminlte",
      title: "Matriculation Numbers",
      pageTitle: "Matriculation Numbers",
      ...opts,
      sessionId,
      rows,
      sequence: sequence || { last_number: 0 },
    });
  } catch (error) {
    next(error);
  }
}
export async function generateMatric(req, res) {
  try {
    const result = await generateMatriculation(id(req.params.applicationId));
    req.flash(
      "success",
      `Matriculation number ${result.matric_number} generated successfully.`,
    );
  } catch (error) {
    req.flash(
      "error",
      error.message || "Matriculation number could not be generated.",
    );
  }
  res.redirect(req.get("referer") || "/staff/admissions/matriculation");
}
export async function generateMatricBulk(req, res) {
  const ids = [
    ...new Set(
      (Array.isArray(req.body.application_ids)
        ? req.body.application_ids
        : [req.body.application_ids]
      )
        .map(id)
        .filter(Boolean),
    ),
  ].slice(0, 250);
  let success = 0;
  const errors = [];
  for (const applicationId of ids) {
    try {
      await generateMatriculation(applicationId);
      success++;
    } catch (error) {
      errors.push(error.message);
    }
  }
  req.flash(
    errors.length ? "error" : "success",
    `${success} matriculation number(s) generated.${errors.length ? ` ${errors.length} skipped: ${errors[0]}` : ""}`,
  );
  res.redirect("/staff/admissions/matriculation");
}

export async function screeningPage(req, res, next) {
  try {
    const opts = await options();
    const sessionId =
      id(req.query.session_id) ||
      id(opts.sessions.find((row) => row.is_current)?.id) ||
      id(opts.sessions[0]?.id);
    const [rows] = await pool.query(
      `SELECT ss.*,s.name session_name,af.title application_title,sc.name school_name,d.name department_name,p.name programme_name,aa.application_number
       FROM screening_schedules ss JOIN sessions s ON s.id=ss.session_id
       LEFT JOIN application_forms af ON af.id=ss.application_form_id LEFT JOIN schools sc ON sc.id=ss.school_id
       LEFT JOIN departments d ON d.id=ss.department_id LEFT JOIN programmes p ON p.id=ss.programme_id
       LEFT JOIN applicant_applications aa ON aa.id=ss.applicant_application_id
       WHERE ss.session_id=? ORDER BY ss.screening_date DESC,ss.start_time,ss.id DESC`,
      [sessionId],
    );
    let editRow = null;
    if (id(req.query.edit))
      [[editRow]] = await pool.query(
        `SELECT * FROM screening_schedules WHERE id=?`,
        [id(req.query.edit)],
      );
    res.render("pages/staff/screening-schedules", {
      layout: "layouts/adminlte",
      title: "Screening Schedules",
      pageTitle: "Screening Schedules",
      ...opts,
      sessionId,
      rows,
      editRow,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateScreening(req, res) {
  try {
    const scheduleId = id(req.params.id),
      sessionId = id(req.body.session_id);
    const [[before]] = await pool.query(
      `SELECT * FROM screening_schedules WHERE id=?`,
      [scheduleId],
    );
    if (!before) throw new Error("Screening schedule not found.");
    if (
      !sessionId ||
      !/^\d{4}-\d{2}-\d{2}$/.test(clean(req.body.screening_date)) ||
      !clean(req.body.venue)
    )
      throw new Error("Session, screening date and venue are required.");
    const status = req.body.publish_now ? "PUBLISHED" : "DRAFT";
    await pool.query(
      `UPDATE screening_schedules SET session_id=?,application_form_id=?,school_id=?,department_id=?,programme_id=?,applicant_application_id=?,screening_type=?,screening_date=?,reporting_time=?,start_time=?,venue=?,batch_name=?,instructions=?,status=?,updated_by=? WHERE id=?`,
      [
        sessionId,
        id(req.body.application_form_id) || null,
        id(req.body.school_id) || null,
        id(req.body.department_id) || null,
        id(req.body.programme_id) || null,
        id(req.body.applicant_application_id) || null,
        clean(req.body.screening_type) || "Entrance Screening",
        req.body.screening_date,
        clean(req.body.reporting_time) || null,
        clean(req.body.start_time) || null,
        clean(req.body.venue),
        clean(req.body.batch_name) || null,
        clean(req.body.instructions) || null,
        status,
        req.user?.id || null,
        scheduleId,
      ],
    );
    await writeAudit(null, req, {
      action: "SCREENING_SCHEDULE_UPDATED",
      entityType: "screening_schedule",
      entityId: scheduleId,
      oldValues: before,
      newValues: {
        date: req.body.screening_date,
        venue: req.body.venue,
        status,
      },
    });
    if (status === "PUBLISHED")
      await notifyScreeningApplicants(
        scheduleId,
        before.status === "PUBLISHED",
      );
    req.flash(
      "success",
      "Screening schedule updated. Matched applicants were notified of published changes.",
    );
  } catch (error) {
    req.flash("error", error.message || "Unable to update screening schedule.");
  }
  res.redirect("/staff/admissions/screening");
}

export async function createScreening(req, res) {
  try {
    const sessionId = id(req.body.session_id);
    if (
      !sessionId ||
      !/^\d{4}-\d{2}-\d{2}$/.test(clean(req.body.screening_date)) ||
      !clean(req.body.venue)
    )
      throw new Error("Session, screening date and venue are required.");
    const [result] = await pool.query(
      `INSERT INTO screening_schedules
       (session_id,application_form_id,school_id,department_id,programme_id,applicant_application_id,screening_type,screening_date,reporting_time,start_time,venue,batch_name,instructions,status,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        sessionId,
        id(req.body.application_form_id) || null,
        id(req.body.school_id) || null,
        id(req.body.department_id) || null,
        id(req.body.programme_id) || null,
        id(req.body.applicant_application_id) || null,
        clean(req.body.screening_type) || "Entrance Screening",
        req.body.screening_date,
        clean(req.body.reporting_time) || null,
        clean(req.body.start_time) || null,
        clean(req.body.venue),
        clean(req.body.batch_name) || null,
        clean(req.body.instructions) || null,
        req.body.publish_now ? "PUBLISHED" : "DRAFT",
        req.user?.id || null,
        req.user?.id || null,
      ],
    );
    await writeAudit(null, req, {
      action: "SCREENING_SCHEDULE_CREATED",
      entityType: "screening_schedule",
      entityId: result.insertId,
      newValues: {
        session_id: sessionId,
        date: req.body.screening_date,
        venue: req.body.venue,
        status: req.body.publish_now ? "PUBLISHED" : "DRAFT",
      },
    });
    if (req.body.publish_now) await notifyScreeningApplicants(result.insertId);
    req.flash("success", "Screening schedule created successfully.");
  } catch (error) {
    req.flash("error", error.message || "Unable to create screening schedule.");
  }
  res.redirect(
    `/staff/admissions/screening?session_id=${id(req.body.session_id)}`,
  );
}

export async function changeScreeningStatus(req, res) {
  try {
    const scheduleId = id(req.params.id),
      status = clean(req.body.status).toUpperCase();
    if (!["DRAFT", "PUBLISHED", "CANCELLED"].includes(status))
      throw new Error("Invalid schedule status.");
    const [[before]] = await pool.query(
      `SELECT * FROM screening_schedules WHERE id=?`,
      [scheduleId],
    );
    if (!before) throw new Error("Screening schedule not found.");
    await pool.query(
      `UPDATE screening_schedules SET status=?,updated_by=? WHERE id=?`,
      [status, req.user?.id || null, scheduleId],
    );
    await writeAudit(null, req, {
      action: "SCREENING_STATUS_CHANGED",
      entityType: "screening_schedule",
      entityId: scheduleId,
      oldValues: { status: before.status },
      newValues: { status },
    });
    if (status === "PUBLISHED") await notifyScreeningApplicants(scheduleId);
    req.flash("success", `Screening schedule marked ${status.toLowerCase()}.`);
  } catch (error) {
    req.flash("error", error.message || "Unable to update screening schedule.");
  }
  res.redirect(req.get("referer") || "/staff/admissions/screening");
}

async function notifyScreeningApplicants(scheduleId, forceUpdate = false) {
  const [[schedule]] = await pool.query(
    `SELECT * FROM screening_schedules WHERE id=?`,
    [scheduleId],
  );
  if (!schedule) return;
  const [applications] = await pool.query(
    `SELECT aa.id,aa.applicant_user_id,aa.application_form_id,aa.form_data,pu.username email FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN public_users pu ON pu.id=aa.applicant_user_id WHERE af.session_id=? AND aa.submitted_at IS NOT NULL`,
    [schedule.session_id],
  );
  for (const app of applications) {
    let data = {};
    try {
      data =
        typeof app.form_data === "object"
          ? app.form_data
          : JSON.parse(app.form_data || "{}");
    } catch {}
    const choice = data?.application_details?.programme_choice || {};
    const matches =
      (!schedule.application_form_id ||
        Number(schedule.application_form_id) ===
          Number(app.application_form_id)) &&
      (!schedule.applicant_application_id ||
        Number(schedule.applicant_application_id) === Number(app.id)) &&
      (!schedule.school_id ||
        Number(schedule.school_id) === Number(choice.school_id)) &&
      (!schedule.department_id ||
        Number(schedule.department_id) === Number(choice.department_id)) &&
      (!schedule.programme_id ||
        Number(schedule.programme_id) === Number(choice.programme_id));
    if (!matches) continue;
    const type = forceUpdate
      ? `SCREENING_${schedule.id}_UPDATE_${Date.now()}`
      : `SCREENING_${schedule.id}`;
    const [[existing]] = await pool.query(
      `SELECT id FROM portal_notifications WHERE public_user_id=? AND applicant_application_id=? AND notification_type=? LIMIT 1`,
      [app.applicant_user_id, app.id, type],
    );
    if (existing) continue;
    const notificationId = await createPortalNotification(null, {
      publicUserId: app.applicant_user_id,
      applicationId: app.id,
      type,
      title: forceUpdate
        ? "Your screening schedule has been updated"
        : "Your screening schedule is available",
      message: `Your screening is scheduled for ${new Date(schedule.screening_date).toLocaleDateString("en-GB")} at ${schedule.venue}. Sign in to view the full details and print your QR screening slip.`,
      actionUrl: "/applicant/screening",
      email: app.email,
    });
    dispatchNotificationEmails(notificationId).catch(() => {});
  }
}

const allowedTemplateTypes = new Set([
  "ADMISSION_NOTIFICATION",
  "ADMISSION_LETTER",
  "SCREENING_SLIP",
]);
function sanitizeTemplate(value) {
  return clean(value)
    .replace(
      /<\/?(?:script|iframe|object|embed|form|link|meta|img)[^>]*>/gi,
      "",
    )
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/(?:url|expression)\s*\([^)]*\)/gi, "");
}
const templateUpload = (req, name) => req.files?.[name]?.[0] || null;
async function storeTemplateUpload(file, prefix) {
  if (!file) return null;
  const signature = file.buffer.subarray(0, 8).toString("hex");
  const isPng = signature === "89504e470d0a1a0a",
    isJpeg = signature.startsWith("ffd8ff");
  if (!isPng && !isJpeg)
    throw new Error(
      `${prefix === "registrar-signature" ? "Registrar signature" : "Watermark image"} must be a genuine PNG or JPEG file.`,
    );
  const directory = path.resolve("app/web/public/uploads/admission-templates");
  await fs.mkdir(directory, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${isPng ? "png" : "jpg"}`;
  const storagePath = path.join(directory, filename);
  await fs.writeFile(storagePath, file.buffer, {
    flag: "wx",
  });
  return `/public/uploads/admission-templates/${filename}`;
}
async function storeTemplateAttachment(file) {
  if (!file) return null;
  if (file.buffer.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("The additional document must be a genuine PDF file.");
  const directory = path.resolve("app/uploads/admission-template-attachments");
  await fs.mkdir(directory, { recursive: true });
  const filename = `attachment-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.pdf`;
  const storagePath = path.join(directory, filename);
  await fs.writeFile(storagePath, file.buffer, {
    flag: "wx",
  });
  return {
    path: path.relative(process.cwd(), storagePath),
    name: path.basename(file.originalname || "Additional document.pdf"),
  };
}

export async function templatesPage(req, res, next) {
  try {
    const opts = await options();
    const [rows] = await pool.query(
      `SELECT adt.*,s.name session_name,af.title application_title FROM admission_document_templates adt LEFT JOIN sessions s ON s.id=adt.session_id LEFT JOIN application_forms af ON af.id=adt.application_form_id ORDER BY adt.document_type,adt.created_at DESC`,
    );
    let editTemplate = null;
    if (id(req.query.edit))
      [[editTemplate]] = await pool.query(
        `SELECT * FROM admission_document_templates WHERE id=?`,
        [id(req.query.edit)],
      );
    res.render("pages/staff/admission-templates", {
      layout: "layouts/adminlte",
      title: "Admission Documents",
      pageTitle: "Admission Documents",
      ...opts,
      rows,
      editTemplate,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateTemplate(req, res) {
  try {
    const templateId = id(req.params.id);
    const [[existing]] = await pool.query(
      `SELECT * FROM admission_document_templates WHERE id=?`,
      [templateId],
    );
    if (!existing) throw new Error("Document template not found.");
    const type = clean(req.body.document_type).toUpperCase();
    if (!allowedTemplateTypes.has(type))
      throw new Error("Invalid document type.");
    const title = clean(req.body.title),
      titleLine2 = clean(req.body.title_line_2) || null,
      body = sanitizeTemplate(req.body.body_html);
    if (!title || !body)
      throw new Error("Template title and body are required.");
    const sessionId = id(req.body.session_id) || null,
      formId = id(req.body.application_form_id) || null;
    const watermarkImagePath = await storeTemplateUpload(
      templateUpload(req, "watermark_image"),
      "watermark",
    );
    const registrarSignaturePath = await storeTemplateUpload(
      templateUpload(req, "registrar_signature"),
      "registrar-signature",
    );
    const attachment = await storeTemplateAttachment(
      templateUpload(req, "document_attachment"),
    );
    const values = [
      type,
      sessionId,
      formId,
      title,
      titleLine2,
      body,
      clean(req.body.watermark_text) || null,
      watermarkImagePath || existing.watermark_image_path,
      Math.min(0.5, Math.max(0.03, Number(req.body.watermark_opacity) || 0.1)),
      clean(req.body.registrar_name) || null,
      clean(req.body.registrar_position) || null,
      registrarSignaturePath || existing.registrar_signature_path,
      attachment?.path || existing.attachment_path,
      attachment?.name || existing.attachment_name,
    ];
    if (existing.status === "DRAFT")
      await pool.query(
        `UPDATE admission_document_templates SET document_type=?,session_id=?,application_form_id=?,title=?,title_line_2=?,body_html=?,watermark_text=?,watermark_image_path=?,watermark_opacity=?,registrar_name=?,registrar_position=?,registrar_signature_path=?,attachment_path=?,attachment_name=? WHERE id=?`,
        [...values, templateId],
      );
    else {
      const [[version]] = await pool.query(
        `SELECT COALESCE(MAX(version_no),0)+1 next_version FROM admission_document_templates WHERE document_type=? AND (session_id<=>?) AND (application_form_id<=>?)`,
        [type, sessionId, formId],
      );
      const [result] = await pool.query(
        `INSERT INTO admission_document_templates (document_type,session_id,application_form_id,title,title_line_2,body_html,version_no,status,created_by,watermark_text,watermark_image_path,watermark_opacity,registrar_name,registrar_position,registrar_signature_path,attachment_path,attachment_name) VALUES (?,?,?,?,?,?,?, 'DRAFT',?,?,?,?,?,?,?,?,?)`,
        [
          type,
          sessionId,
          formId,
          title,
          titleLine2,
          body,
          version.next_version,
          req.user?.id || null,
          values[6],
          values[7],
          values[8],
          values[9],
          values[10],
          values[11],
          values[12],
          values[13],
        ],
      );
      await writeAudit(null, req, {
        action: "ADMISSION_TEMPLATE_REVISION_CREATED",
        entityType: "admission_document_template",
        entityId: result.insertId,
        oldValues: { source_template_id: templateId },
        newValues: { version: version.next_version },
      });
    }
    req.flash(
      "success",
      existing.status === "DRAFT"
        ? "Document template updated."
        : "A new draft revision was created; the published version remains unchanged.",
    );
  } catch (error) {
    req.flash("error", error.message || "Unable to update document template.");
  }
  res.redirect("/staff/admissions/documents");
}

export async function createTemplate(req, res) {
  try {
    const type = clean(req.body.document_type).toUpperCase();
    if (!allowedTemplateTypes.has(type))
      throw new Error("Invalid document type.");
    const title = clean(req.body.title),
      titleLine2 = clean(req.body.title_line_2) || null,
      body = sanitizeTemplate(req.body.body_html);
    if (!title || !body)
      throw new Error("Template title and body are required.");
    const sessionId = id(req.body.session_id) || null,
      formId = id(req.body.application_form_id) || null;
    const watermarkImagePath = await storeTemplateUpload(
      templateUpload(req, "watermark_image"),
      "watermark",
    );
    const registrarSignaturePath = await storeTemplateUpload(
      templateUpload(req, "registrar_signature"),
      "registrar-signature",
    );
    const attachment = await storeTemplateAttachment(
      templateUpload(req, "document_attachment"),
    );
    const [[version]] = await pool.query(
      `SELECT COALESCE(MAX(version_no),0)+1 next_version FROM admission_document_templates WHERE document_type=? AND (session_id<=>?) AND (application_form_id<=>?)`,
      [type, sessionId, formId],
    );
    const [result] = await pool.query(
      `INSERT INTO admission_document_templates (document_type,session_id,application_form_id,title,title_line_2,body_html,version_no,status,created_by,watermark_text,watermark_image_path,watermark_opacity,registrar_name,registrar_position,registrar_signature_path,attachment_path,attachment_name) VALUES (?,?,?,?,?,?,?, 'DRAFT',?,?,?,?,?,?,?,?,?)`,
      [
        type,
        sessionId,
        formId,
        title,
        titleLine2,
        body,
        version.next_version,
        req.user?.id || null,
        clean(req.body.watermark_text) || null,
        watermarkImagePath,
        Math.min(
          0.5,
          Math.max(0.03, Number(req.body.watermark_opacity) || 0.1),
        ),
        clean(req.body.registrar_name) || null,
        clean(req.body.registrar_position) || null,
        registrarSignaturePath,
        attachment?.path || null,
        attachment?.name || null,
      ],
    );
    await writeAudit(null, req, {
      action: "ADMISSION_TEMPLATE_CREATED",
      entityType: "admission_document_template",
      entityId: result.insertId,
      newValues: {
        type,
        title,
        session_id: sessionId,
        application_form_id: formId,
        version: version.next_version,
      },
    });
    req.flash("success", "Document template draft created.");
  } catch (error) {
    req.flash("error", error.message || "Unable to create document template.");
  }
  res.redirect("/staff/admissions/documents");
}

const sampleValues = {
  applicant_name: "ADEBAYO GRACE OLUWATOBI",
  application_number: "APP-2026-SAMPLE-001",
  programme_name: "Community Health",
  department_name: "Community Health Sciences",
  school_name: "School of Allied Health Sciences",
  session_name: "2026/2027",
  current_date: new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }),
  admission_date: new Date().toLocaleDateString("en-GB"),
  screening_date: "15 October 2026",
  screening_time: "9:00 AM",
  screening_venue: "College Main Hall",
};
function replaceSample(value) {
  let text = String(value || "");
  for (const [key, val] of Object.entries(sampleValues))
    text = text.replaceAll(`{{${key}}}`, val);
  return text;
}
function drawTiledImageWatermark(doc, image, opacity = 0.1) {
  const xs = [65, 250, 435],
    ys = [180, 390, 600];
  for (const y of ys)
    for (const x of xs) {
      try {
        doc
          .save()
          .opacity(opacity)
          .image(image, x, y, {
            fit: [95, 105],
            align: "center",
            valign: "center",
          })
          .restore()
          .opacity(1);
      } catch {}
    }
}
function sampleVerificationUrl(req) {
  const base = String(
    process.env.PORTAL_BASE_URL || `${req.protocol}://${req.get("host")}`,
  ).replace(/\/$/, "");
  return `${base}/verify/admission-document/sample`;
}
async function sampleQrData(req) {
  return QRCode.toDataURL(sampleVerificationUrl(req), {
    width: 180,
    margin: 1,
    errorCorrectionLevel: "M",
  });
}
function drawSamplePersonalWatermark(doc, type) {
  const purpose =
    type === "SCREENING_SLIP"
      ? "SCREENING SLIP"
      : type === "ADMISSION_NOTIFICATION"
        ? "ADMISSION NOTIFICATION"
        : "ADMISSION LETTER";
  const text = `ADEBAYO GRACE OLUWATOBI • COMMUNITY HEALTH • 2026/2027 • ${purpose}`;
  for (const y of [230, 390, 550, 710])
    doc
      .save()
      .opacity(0.11)
      .fillColor("#d71920")
      .font("Helvetica-Bold")
      .fontSize(18)
      .rotate(-24, { origin: [300, y] })
      .text(text, 45, y, { width: 520, align: "center" })
      .restore()
      .opacity(1);
}
function drawSampleContinuation(doc, template, qr, imageSource) {
  if (template.watermark_text)
    doc
      .save()
      .font("Helvetica-Bold")
      .fontSize(55)
      .fillColor("#777")
      .opacity(Number(template.watermark_opacity) || 0.1)
      .rotate(-35, { origin: [300, 430] })
      .text(template.watermark_text, 80, 360, { width: 500, align: "center" })
      .restore()
      .opacity(1);
  if (imageSource)
    drawTiledImageWatermark(
      doc,
      imageSource,
      Number(template.watermark_opacity) || 0.1,
    );
  drawSamplePersonalWatermark(doc, template.document_type);
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#555")
    .text(`Printed: ${new Date().toLocaleString("en-GB")}`, 390, 18, {
      width: 150,
      align: "right",
      lineBreak: false,
      lineBreak: false,
    });
  if (qr) {
    doc.image(qr, 485, 700, { width: 52 });
    doc
      .fontSize(6)
      .text("Verification Code", 470, 754, {
        width: 82,
        align: "center",
        lineBreak: false,
      });
  }
  doc.x = 55;
  doc.y = 55;
}
function draftTemplateFromRequest(req) {
  const opacity = Math.min(
    0.5,
    Math.max(0.03, Number(req.body.watermark_opacity) || 0.1),
  );
  const watermarkUpload = templateUpload(req, "watermark_image"),
    signatureUpload = templateUpload(req, "registrar_signature");
  const retainedPath = (value) =>
    String(value || "").startsWith("/public/uploads/admission-templates/")
      ? String(value)
      : null;
  const retainedAttachmentPath = (value) =>
    String(value || "").startsWith("app/uploads/admission-template-attachments/")
      ? String(value)
      : null;
  const template = {
    document_type:
      clean(req.body.document_type).toUpperCase() || "ADMISSION_LETTER",
    title: replaceSample(clean(req.body.title) || "Document sample"),
    title_line_2: replaceSample(clean(req.body.title_line_2)) || null,
    body_html: replaceSample(
      sanitizeTemplate(req.body.body_html) ||
        "<p>Enter the document content before previewing.</p>",
    ),
    watermark_text: clean(req.body.watermark_text) || null,
    watermark_opacity: opacity,
    watermark_image_path: watermarkUpload
      ? `data:${watermarkUpload.mimetype};base64,${watermarkUpload.buffer.toString("base64")}`
      : retainedPath(req.body.existing_watermark_image_path),
    watermark_image_buffer: watermarkUpload?.buffer || null,
    registrar_name: clean(req.body.registrar_name) || null,
    registrar_position: clean(req.body.registrar_position) || null,
    registrar_signature_path: signatureUpload
      ? `data:${signatureUpload.mimetype};base64,${signatureUpload.buffer.toString("base64")}`
      : retainedPath(req.body.existing_registrar_signature_path),
    registrar_signature_buffer: signatureUpload?.buffer || null,
    passport_path: "/public/img/avatar.png",
    printed_at: new Date().toLocaleString("en-GB"),
    attachment_path: templateUpload(req, "document_attachment")
      ? `data:application/pdf;base64,${templateUpload(req, "document_attachment").buffer.toString("base64")}`
      : retainedAttachmentPath(req.body.existing_attachment_path),
  };
  const purpose =
    template.document_type === "SCREENING_SLIP"
      ? "SCREENING SLIP"
      : template.document_type === "ADMISSION_NOTIFICATION"
        ? "ADMISSION NOTIFICATION"
        : "ADMISSION LETTER";
  template.personal_watermark = `ADEBAYO GRACE OLUWATOBI • COMMUNITY HEALTH • 2026/2027 • ${purpose}`;
  return template;
}
export async function previewDraftTemplate(req, res, next) {
  try {
    const template = draftTemplateFromRequest(req);
    if (template.attachment_path?.startsWith("app/uploads/")) {
      const attachment = await fs.readFile(path.resolve(template.attachment_path));
      template.attachment_path = `data:application/pdf;base64,${attachment.toString("base64")}`;
    }
    template.qr_data_url = await sampleQrData(req);
    return res.render("pages/staff/document-preview", {
      layout: false,
      template,
      sampleValues,
    });
  } catch (error) {
    next(error);
  }
}
export async function renderSamplePdf(template, req) {
  const qr = await QRCode.toBuffer(sampleVerificationUrl(req), {
    width: 180,
    margin: 1,
  });
  const imageSource =
    template.watermark_image_buffer ||
    (template.watermark_image_path &&
    !template.watermark_image_path.startsWith("data:")
      ? path.resolve("app/web" + template.watermark_image_path)
      : null);
  const doc = new PDFDocument({ size: "A4", margin: 55, bufferPages: true });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.on("pageAdded", () =>
    drawSampleContinuation(doc, template, qr, imageSource),
  );
  if (template.watermark_text)
    doc
      .save()
      .font("Helvetica-Bold")
      .fontSize(55)
      .fillColor("#777")
      .opacity(Number(template.watermark_opacity) || 0.1)
      .rotate(-35, { origin: [300, 430] })
      .text(template.watermark_text, 80, 360, { width: 500, align: "center" })
      .restore()
      .opacity(1);
  if (imageSource)
    drawTiledImageWatermark(
      doc,
      imageSource,
      Number(template.watermark_opacity) || 0.1,
    );
  drawSamplePersonalWatermark(doc, template.document_type);
  try {
    doc.image(path.resolve("app/web/public/img/logo.png"), 55, 35, {
      width: 65,
    });
    doc.image(path.resolve("app/web/public/img/avatar.png"), 475, 35, {
      fit: [78, 92],
    });
  } catch {}
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#555")
    .text(`Printed: ${new Date().toLocaleString("en-GB")}`, 390, 18, {
      width: 150,
      align: "right",
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .fillColor("#247D57")
    .text("EKITI STATE COLLEGE OF TECHNOLOGY", 130, 40, {
      width: 335,
      align: "center",
    })
    .fontSize(10)
    .fillColor("#333")
    .text("IJERO-EKITI, EKITI STATE", 130, 62, { width: 335, align: "center" })
    .text("P.M.B. 316, Epe Ara Road, Ijero-Ekiti, Ekiti State", 130, 78, {
      width: 335,
      align: "center",
    });
  doc.moveTo(55, 115).lineTo(540, 115).strokeColor("#82103C").stroke();
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#82103C")
    .text(replaceSample(template.title), 55, 135, { align: "center" });
  let bodyY = 180;
  if (template.title_line_2) {
    doc
      .fontSize(15)
      .text(replaceSample(template.title_line_2), 55, 160, { align: "center" });
    bodyY = 200;
  }
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#222")
    .text(
      replaceSample(template.body_html)
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]+>/g, ""),
      55,
      bodyY,
      { align: "justify", lineGap: 4 },
    );
  let signatureY = Math.max(doc.y + 25, 610);
  if (signatureY > 680) {
    doc.addPage();
    signatureY = 100;
  }
  const signatureSource =
    template.registrar_signature_buffer ||
    (template.registrar_signature_path &&
    !template.registrar_signature_path.startsWith("data:")
      ? path.resolve("app/web" + template.registrar_signature_path)
      : null);
  if (signatureSource) {
    try {
      doc.image(signatureSource, 65, signatureY, { fit: [145, 58] });
    } catch {}
  }
  signatureY += 62;
  if (template.registrar_name || template.registrar_position)
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#222")
      .text(template.registrar_name || "Registrar", 65, signatureY, {
        width: 210,
      })
      .font("Helvetica")
      .fontSize(9)
      .text(template.registrar_position || "Registrar", 65, signatureY + 16, {
        width: 210,
      });
  doc.image(qr, 485, 700, { width: 52 });
  doc
    .fontSize(6)
    .fillColor("#555")
    .text("Verification Code", 470, 754, {
      width: 82,
      align: "center",
      lineBreak: false,
    });
  doc
    .fontSize(8)
    .fillColor("#777")
    .text("SAMPLE — NOT VALID FOR ADMISSION", 55, 760, {
      width: 390,
      align: "center",
      lineBreak: false,
    });
  doc.end();
  let output = await done;
  let attachment = null;
  if (template.attachment_path?.startsWith("data:"))
    attachment = Buffer.from(
      template.attachment_path.split(",")[1] || "",
      "base64",
    );
  else if (template.attachment_path) {
    try {
      attachment = await fs.readFile(
        path.resolve(template.attachment_path),
      );
    } catch {}
  }
  if (attachment) {
    const target = await PDFLibDocument.load(output);
    const source = await PDFLibDocument.load(attachment);
    const pages = await target.copyPages(source, source.getPageIndices());
    const font = await target.embedFont(StandardFonts.Helvetica);
    const qrImage = await target.embedPng(qr);
    const stamp = new Date().toLocaleString("en-GB");
    pages.forEach((page) => {
      const { width, height } = page.getSize();
      page.drawText(`Printed: ${stamp}`, {
        x: width - 175,
        y: height - 18,
        size: 7,
        font,
        color: rgb(0.33, 0.33, 0.33),
      });
      page.drawImage(qrImage, {
        x: width - 70,
        y: 25,
        width: 45,
        height: 45,
      });
      page.drawText("Verification Code", {
        x: width - 82,
        y: 15,
        size: 5.5,
        font,
        color: rgb(0.33, 0.33, 0.33),
      });
      target.addPage(page);
    });
    output = Buffer.from(await target.save());
  }
  return output;
}
export async function sampleDraftTemplatePdf(req, res, next) {
  try {
    const template = draftTemplateFromRequest(req);
    const output = await renderSamplePdf(template, req);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${template.document_type.toLowerCase()}-draft-sample.pdf"`,
    );
    res.send(output);
  } catch (error) {
    next(error);
  }
}
export async function previewTemplate(req, res, next) {
  try {
    const [[template]] = await pool.query(
      `SELECT * FROM admission_document_templates WHERE id=?`,
      [id(req.params.id)],
    );
    if (!template) return res.status(404).send("Template not found.");
    const purpose =
      template.document_type === "SCREENING_SLIP"
        ? "SCREENING SLIP"
        : template.document_type === "ADMISSION_NOTIFICATION"
          ? "ADMISSION NOTIFICATION"
          : "ADMISSION LETTER";
    res.render("pages/staff/document-preview", {
      layout: false,
      template: {
        ...template,
        title: replaceSample(template.title),
        title_line_2: replaceSample(template.title_line_2),
        body_html: replaceSample(template.body_html),
        qr_data_url: await sampleQrData(req),
        passport_path: "/public/img/avatar.png",
        printed_at: new Date().toLocaleString("en-GB"),
        attachment_path: template.attachment_path
          ? `/staff/admissions/documents/${template.id}/attachment`
          : null,
        personal_watermark: `ADEBAYO GRACE OLUWATOBI • COMMUNITY HEALTH • 2026/2027 • ${purpose}`,
      },
      sampleValues,
    });
  } catch (error) {
    next(error);
  }
}
export async function templateAttachment(req,res,next){try{const [[template]]=await pool.query(`SELECT attachment_path,attachment_name FROM admission_document_templates WHERE id=?`,[id(req.params.id)]);if(!template?.attachment_path)return res.status(404).send('Attachment not found.');const filePath=path.resolve(template.attachment_path);const allowedRoot=path.resolve('app/uploads/admission-template-attachments')+path.sep;if(!filePath.startsWith(allowedRoot))return res.status(403).send('Attachment path is not permitted.');res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="${path.basename(template.attachment_name||'additional-document.pdf').replace(/["\r\n]/g,'')}"`);return res.sendFile(filePath)}catch(error){next(error)}}
export async function sampleTemplatePdf(req, res, next) {
  try {
    const [[template]] = await pool.query(
      `SELECT * FROM admission_document_templates WHERE id=?`,
      [id(req.params.id)],
    );
    if (!template) return res.status(404).send("Template not found.");
    const output = await renderSamplePdf(template, req);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${template.document_type.toLowerCase()}-sample.pdf"`,
    );
    res.send(output);
  } catch (error) {
    next(error);
  }
}

export async function publishTemplate(req, res) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const templateId = id(req.params.id);
    const [[template]] = await connection.query(
      `SELECT * FROM admission_document_templates WHERE id=? FOR UPDATE`,
      [templateId],
    );
    if (!template) throw new Error("Template not found.");
    await connection.query(
      `UPDATE admission_document_templates SET status='ARCHIVED' WHERE document_type=? AND (session_id<=>?) AND (application_form_id<=>?) AND status='PUBLISHED'`,
      [
        template.document_type,
        template.session_id,
        template.application_form_id,
      ],
    );
    await connection.query(
      `UPDATE admission_document_templates SET status='PUBLISHED',published_by=?,published_at=NOW() WHERE id=?`,
      [req.user?.id || null, templateId],
    );
    await writeAudit(connection, req, {
      action: "ADMISSION_TEMPLATE_PUBLISHED",
      entityType: "admission_document_template",
      entityId: templateId,
      newValues: { status: "PUBLISHED", version: template.version_no },
    });
    await connection.commit();
    req.flash("success", "Document template published.");
  } catch (error) {
    await connection.rollback();
    req.flash("error", error.message || "Unable to publish template.");
  } finally {
    connection.release();
  }
  res.redirect("/staff/admissions/documents");
}

export async function announcementsPage(req, res, next) {
  try {
    const opts = await options();
    const [rows] = await pool.query(
      `SELECT pa.*,s.name session_name,sc.name school_name,d.name department_name,p.name programme_name FROM portal_announcements pa LEFT JOIN sessions s ON s.id=pa.session_id LEFT JOIN schools sc ON sc.id=pa.school_id LEFT JOIN departments d ON d.id=pa.department_id LEFT JOIN programmes p ON p.id=pa.programme_id ORDER BY pa.created_at DESC`,
    );
    let editRow = null;
    if (id(req.query.edit))
      [[editRow]] = await pool.query(
        `SELECT * FROM portal_announcements WHERE id=?`,
        [id(req.query.edit)],
      );
    res.render("pages/staff/announcements", {
      layout: "layouts/adminlte",
      title: "Announcement Board",
      pageTitle: "Announcement Board",
      ...opts,
      rows,
      editRow,
    });
  } catch (error) {
    next(error);
  }
}

async function notifyAnnouncement(announcementId) {
  const [[a]] = await pool.query(
    `SELECT * FROM portal_announcements WHERE id=?`,
    [announcementId],
  );
  if (!a || a.status !== "PUBLISHED") return;
  let users = [];
  if (["applicant", "both"].includes(a.audience_role)) {
    [users] = await pool.query(
      `SELECT DISTINCT pu.id public_user_id,pu.username email,aa.id application_id FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN public_users pu ON pu.id=aa.applicant_user_id WHERE aa.submitted_at IS NOT NULL AND (? IS NULL OR af.session_id=?) AND (? IS NULL OR aa.application_form_id=?) AND (? IS NULL OR aa.status=?) AND (? IS NULL OR ?=CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.school_id')) AS UNSIGNED)) AND (? IS NULL OR ?=CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.department_id')) AS UNSIGNED)) AND (? IS NULL OR ?=CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.programme_id')) AS UNSIGNED))`,
      [
        a.session_id,
        a.session_id,
        a.application_form_id,
        a.application_form_id,
        a.admission_status,
        a.admission_status,
        a.school_id,
        a.school_id,
        a.department_id,
        a.department_id,
        a.programme_id,
        a.programme_id,
      ],
    );
  }
  if (["student", "both"].includes(a.audience_role)) {
    const [students] = await pool.query(
      `SELECT DISTINCT pu.id public_user_id,pu.username email,NULL application_id FROM public_users pu LEFT JOIN student_profiles sp ON sp.user_id=pu.id WHERE (pu.role='student' OR EXISTS(SELECT 1 FROM portal_user_roles pur WHERE pur.public_user_id=pu.id AND pur.role='student')) AND (? IS NULL OR sp.school_id=?) AND (? IS NULL OR sp.department_id=?) AND (? IS NULL OR sp.programme_id=?)`,
      [
        a.school_id,
        a.school_id,
        a.department_id,
        a.department_id,
        a.programme_id,
        a.programme_id,
      ],
    );
    users.push(...students);
  }
  for (const u of users) {
    const type = `ANNOUNCEMENT_${a.id}`;
    const [[exists]] = await pool.query(
      `SELECT id FROM portal_notifications WHERE public_user_id=? AND notification_type=? LIMIT 1`,
      [u.public_user_id, type],
    );
    if (exists) continue;
    const notificationId = await createPortalNotification(null, {
      publicUserId: u.public_user_id,
      applicationId: u.application_id,
      type,
      title: a.title,
      message: a.body,
      actionUrl: "/applicant/announcements",
      email: u.email,
    });
    dispatchNotificationEmails(notificationId).catch(() => {});
  }
}

export async function createAnnouncement(req, res) {
  try {
    const title = clean(req.body.title),
      body = clean(req.body.body);
    if (!title || !body) throw new Error("Title and message are required.");
    const audience = clean(req.body.audience_role);
    if (!["applicant", "student", "both"].includes(audience))
      throw new Error("Invalid audience.");
    const publishAt = clean(req.body.publish_at) || new Date();
    const status = req.body.publish_now ? "PUBLISHED" : "DRAFT";
    const [result] = await pool.query(
      `INSERT INTO portal_announcements (title,body,audience_role,session_id,application_form_id,school_id,department_id,programme_id,admission_status,priority,publish_at,expires_at,status,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        title,
        body,
        audience,
        id(req.body.session_id) || null,
        id(req.body.application_form_id) || null,
        id(req.body.school_id) || null,
        id(req.body.department_id) || null,
        id(req.body.programme_id) || null,
        clean(req.body.admission_status) || null,
        clean(req.body.priority) || "NORMAL",
        publishAt,
        clean(req.body.expires_at) || null,
        status,
        req.user?.id || null,
        req.user?.id || null,
      ],
    );
    await writeAudit(null, req, {
      action: "ANNOUNCEMENT_CREATED",
      entityType: "portal_announcement",
      entityId: result.insertId,
      newValues: { title, audience, status },
    });
    if (status === "PUBLISHED") await notifyAnnouncement(result.insertId);
    req.flash("success", "Announcement saved.");
  } catch (error) {
    req.flash("error", error.message || "Unable to create announcement.");
  }
  res.redirect("/staff/admissions/announcements");
}

export async function updateAnnouncement(req, res) {
  try {
    const announcementId = id(req.params.id),
      title = clean(req.body.title),
      body = clean(req.body.body),
      audience = clean(req.body.audience_role);
    if (!title || !body || !["applicant", "student", "both"].includes(audience))
      throw new Error("Title, message and a valid audience are required.");
    const [[before]] = await pool.query(
      `SELECT * FROM portal_announcements WHERE id=?`,
      [announcementId],
    );
    if (!before) throw new Error("Announcement not found.");
    const status = req.body.publish_now ? "PUBLISHED" : "DRAFT";
    await pool.query(
      `UPDATE portal_announcements SET title=?,body=?,audience_role=?,session_id=?,application_form_id=?,school_id=?,department_id=?,programme_id=?,admission_status=?,priority=?,publish_at=?,expires_at=?,status=?,updated_by=? WHERE id=?`,
      [
        title,
        body,
        audience,
        id(req.body.session_id) || null,
        id(req.body.application_form_id) || null,
        id(req.body.school_id) || null,
        id(req.body.department_id) || null,
        id(req.body.programme_id) || null,
        clean(req.body.admission_status) || null,
        clean(req.body.priority) || "NORMAL",
        clean(req.body.publish_at) || new Date(),
        clean(req.body.expires_at) || null,
        status,
        req.user?.id || null,
        announcementId,
      ],
    );
    await writeAudit(null, req, {
      action: "ANNOUNCEMENT_UPDATED",
      entityType: "portal_announcement",
      entityId: announcementId,
      oldValues: before,
      newValues: { title, body, audience, status },
    });
    if (status === "PUBLISHED" && before.status !== "PUBLISHED")
      await notifyAnnouncement(announcementId);
    req.flash("success", "Announcement updated.");
  } catch (error) {
    req.flash("error", error.message || "Unable to update announcement.");
  }
  res.redirect("/staff/admissions/announcements");
}

export async function notificationDeliveriesPage(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT nd.*,pn.title,pn.notification_type,pn.created_at notification_created,pu.first_name,pu.last_name,aa.application_number FROM notification_deliveries nd JOIN portal_notifications pn ON pn.id=nd.notification_id JOIN public_users pu ON pu.id=pn.public_user_id LEFT JOIN applicant_applications aa ON aa.id=pn.applicant_application_id ORDER BY nd.id DESC LIMIT 250`,
    );
    res.render("pages/staff/admission-notifications", {
      layout: "layouts/adminlte",
      title: "Admission Notifications",
      pageTitle: "Admission Notifications",
      rows,
    });
  } catch (error) {
    next(error);
  }
}
export async function resendNotification(req, res) {
  try {
    const result = await sendPendingEmail(id(req.params.id));
    req.flash(
      result.sent ? "success" : "error",
      result.sent
        ? "Email sent successfully."
        : result.reason || "Email could not be sent.",
    );
  } catch (error) {
    req.flash("error", error.message || "Email could not be sent.");
  }
  res.redirect("/staff/admissions/notifications");
}

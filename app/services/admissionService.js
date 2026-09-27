import db from "../core/db.js";
import { writeAudit } from "./auditService.js";
import { createPortalNotification } from "./notificationService.js";

const clean = value => String(value ?? "").trim();

function parsed(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(String(value || "{}")); } catch { return {}; }
}

function collectSubjects(formData) {
  const values = [];
  const normalizedSubject = value => clean(value).toLowerCase().replace(/[_-]+/g," ").replace(/\s+/g," ");
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const subject = node.subject || node.subject_name || node.name;
    const grade = node.grade || node.result || node.value;
    if (subject && grade) values.push({ subject: normalizedSubject(subject), grade: clean(grade).toUpperCase() });
    for (const [key,value] of Object.entries(node)) {
      if (typeof value === "string" && /^(?:A1|B[23]|C[456]|D7|E8|F9)$/i.test(clean(value))) {
        values.push({ subject: normalizedSubject(key), grade: clean(value).toUpperCase() });
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(formData);
  return values;
}

function passingGrade(grade, minimumGrade) {
  const order = ["A1","B2","B3","C4","C5","C6","D7","E8","F9"];
  const actual = order.indexOf(clean(grade).toUpperCase());
  const minimum = order.indexOf(clean(minimumGrade || "C6").toUpperCase());
  return actual >= 0 && minimum >= 0 && actual <= minimum;
}

async function applicationContext(executor, applicationId, lock = false) {
  const [rows] = await executor.query(
    `SELECT aa.*, af.session_id, af.title AS application_title,
            pu.first_name, pu.middle_name, pu.last_name, pu.username AS email,
            ap.jamb_total_score
       FROM applicant_applications aa
       JOIN application_forms af ON af.id=aa.application_form_id
       JOIN public_users pu ON pu.id=aa.applicant_user_id
       LEFT JOIN application_prerequisites ap
         ON ap.application_form_id=aa.application_form_id
        AND ap.matched_applicant_user_id=aa.applicant_user_id
        AND ap.match_status IN ('MATCHED','USED')
      WHERE aa.id=?
      ORDER BY ap.id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [applicationId],
  );
  return rows[0] || null;
}

function programmeIds(application) {
  const data = parsed(application.form_data);
  const choice = data?.application_details?.programme_choice || {};
  return {
    schoolId: Number(choice.school_id || data.school_id || 0) || null,
    departmentId: Number(choice.department_id || data.department_id || 0) || null,
    programmeId: Number(choice.programme_id || data.programme_id || 0) || null,
    programmeName: clean(choice.programme_name || choice.programme || application.programme_choice),
  };
}

export async function evaluateEligibility(applicationId, executor = db) {
  const application = await applicationContext(executor, applicationId);
  if (!application) return { eligible: false, reasons: ["Application was not found."] };
  const ids = programmeIds(application);
  const [criteria] = await executor.query(
    `SELECT ac.* FROM admission_criteria ac
      WHERE ac.session_id=? AND ac.is_active=1
        AND (ac.application_form_id IS NULL OR ac.application_form_id=?)
        AND (ac.school_id IS NULL OR ac.school_id=?)
        AND (ac.department_id IS NULL OR ac.department_id=?)
        AND (ac.programme_id IS NULL OR ac.programme_id=?)
      ORDER BY (ac.programme_id IS NOT NULL) DESC,
               (ac.department_id IS NOT NULL) DESC,
               (ac.school_id IS NOT NULL) DESC,
               (ac.application_form_id IS NOT NULL) DESC,
               ac.id DESC LIMIT 1`,
    [application.session_id, application.application_form_id, ids.schoolId, ids.departmentId, ids.programmeId],
  );
  const criterion = criteria[0] || null;
  const reasons = [];
  if (!application.submitted_at || !["SUBMITTED","UNDER_REVIEW","ADMITTED"].includes(application.status)) {
    reasons.push("Application has not been submitted.");
  }
  if (!criterion) reasons.push("No admission criterion is configured for this application.");
  const score = application.jamb_total_score == null ? null : Number(application.jamb_total_score);
  if (criterion?.score_required && score == null) reasons.push("Entrance score has not been uploaded and matched.");
  const evaluatedScore=criterion?.score_mode==="PERCENT"&&Number(criterion.maximum_score)>0&&score!=null?(score/Number(criterion.maximum_score))*100:score;
  if (evaluatedScore != null && criterion?.minimum_score != null && evaluatedScore < Number(criterion.minimum_score)) {
    reasons.push(`Entrance score is below the required ${Number(criterion.minimum_score)}${criterion.score_mode==="PERCENT"?"%":""}.`);
  }
  const [subjects] = criterion
    ? await executor.query(`SELECT * FROM admission_criterion_subjects WHERE admission_criterion_id=? AND is_mandatory=1`, [criterion.id])
    : [[]];
  const results = collectSubjects(parsed(application.form_data));
  const distinctPassingSubjects = new Set(
    results.filter(item => passingGrade(item.grade, "C6")).map(item => item.subject),
  );
  if (criterion?.minimum_olevel_credits != null && distinctPassingSubjects.size < Number(criterion.minimum_olevel_credits)) {
    reasons.push(`At least ${Number(criterion.minimum_olevel_credits)} O'level credit passes are required.`);
  }
  for (const required of subjects || []) {
    const requiredName=clean(required.subject_name).toLowerCase().replace(/[_-]+/g," ").replace(/\s+/g," ");
    const found = results.find(item => item.subject === requiredName);
    if (!found || !passingGrade(found.grade, required.minimum_grade)) {
      reasons.push(`${required.subject_name} with at least ${required.minimum_grade || "C6"} is required.`);
    }
  }
  return { eligible: reasons.length === 0, reasons, criterion, score, evaluatedScore, application, ...ids };
}

export async function admitApplication(req, applicationId, options = {}) {
  const connection = await db.getConnection();
  let notificationId;
  try {
    await connection.beginTransaction();
    const application = await applicationContext(connection, applicationId, true);
    if (!application) throw new Error("Application was not found.");
    if (application.status === "ADMITTED") {
      const [[existing]] = await connection.query(`SELECT * FROM admission_decisions WHERE applicant_application_id=? LIMIT 1`, [applicationId]);
      await connection.commit();
      return { admitted: false, existing: true, decision: existing || null };
    }
    const evaluation = await evaluateEligibility(applicationId, connection);
    const override = Boolean(options.override);
    if (!evaluation.eligible && !override) throw new Error(evaluation.reasons.join(" "));
    if (override && !clean(options.reason)) throw new Error("A reason is required for a manual eligibility override.");
    const actorId = req.user?.id || null;
    const [decisionResult] = await connection.query(
      `INSERT INTO admission_decisions
       (applicant_application_id, session_id, offered_school_id, offered_department_id,
        offered_programme_id, offered_programme_name, entrance_score, criterion_id,
        is_manual_override, decision_reason, admitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [applicationId, application.session_id, evaluation.schoolId, evaluation.departmentId,
       evaluation.programmeId, evaluation.programmeName, evaluation.score,
       evaluation.criterion?.id || null, override ? 1 : 0, clean(options.reason) || null, actorId],
    );
    await connection.query(
      `UPDATE applicant_applications SET status='ADMITTED', acceptance_payment_status=IF(acceptance_payment_status='NOT_AVAILABLE','UNPAID',acceptance_payment_status), reviewed_by=?, reviewed_at=NOW() WHERE id=?`,
      [actorId, applicationId],
    );
    const fullName = [application.first_name, application.middle_name, application.last_name].filter(Boolean).join(" ");
    const message = `Congratulations ${fullName}. You have been offered provisional admission${evaluation.programmeName ? ` to study ${evaluation.programmeName}` : ""}. Please sign in to your portal to review the offer and pay the acceptance fee. Your admission letter may be subject to acceptance-fee confirmation.`;
    notificationId = await createPortalNotification(connection, {
      publicUserId: application.applicant_user_id, applicationId, type: "ADMISSION_OFFER",
      title: "Your admission offer", message, actionUrl: "/applicant/admission/status", email: application.email,
    });
    await writeAudit(connection, req, {
      action: "ADMISSION_GRANTED", entityType: "applicant_application", entityId: applicationId,
      reason: clean(options.reason) || null, oldValues: { status: application.status },
      newValues: { status: "ADMITTED", decision_id: decisionResult.insertId, programme: evaluation.programmeName },
    });
    await connection.commit();
    return { admitted: true, decisionId: decisionResult.insertId, notificationId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export async function revokeAdmission(req, applicationId, reason) {
  if (!clean(reason)) throw new Error("A revocation reason is required.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const application = await applicationContext(connection, applicationId, true);
    if (!application || application.status !== "ADMITTED") throw new Error("An active admission was not found.");
    if (application.acceptance_payment_status === "PAID") throw new Error("Admission cannot be revoked after acceptance-fee payment.");
    const [[transition]] = await connection.query(`SELECT id FROM applicant_student_transitions WHERE applicant_application_id=? LIMIT 1`, [applicationId]);
    if (transition) throw new Error("Admission cannot be revoked after Student Portal access has been granted.");
    const actorId = req.user?.id || null;
    await connection.query(
      `UPDATE admission_decisions SET status='REVOKED', revoked_by=?, revoked_at=NOW(), revocation_reason=? WHERE applicant_application_id=? AND status='ADMITTED'`,
      [actorId, clean(reason), applicationId],
    );
    await connection.query(`UPDATE applicant_applications SET status='WITHDRAWN', reviewed_by=?, reviewed_at=NOW() WHERE id=?`, [actorId, applicationId]);
    await connection.query(`UPDATE issued_admission_documents SET status='REVOKED', revoked_at=NOW() WHERE applicant_application_id=? AND document_type IN ('ADMISSION_NOTIFICATION','ADMISSION_LETTER') AND status='VALID'`, [applicationId]);
    const notificationId = await createPortalNotification(connection, {
      publicUserId: application.applicant_user_id, applicationId, type: "ADMISSION_REVOKED",
      title: "Admission status updated",
      message: "Your admission offer has been revoked. Please contact the Registry for clarification. Revocation does not automatically create a refund; any applicable refund is handled manually by the Bursary.",
      actionUrl: "/applicant/admission/status", email: application.email,
    });
    await writeAudit(connection, req, {
      action: "ADMISSION_REVOKED", entityType: "applicant_application", entityId: applicationId,
      reason: clean(reason), oldValues: { status: "ADMITTED" }, newValues: { status: "WITHDRAWN", refund: "MANUAL_BURSARY_ONLY" },
    });
    await connection.commit();
    return { revoked: true, notificationId };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

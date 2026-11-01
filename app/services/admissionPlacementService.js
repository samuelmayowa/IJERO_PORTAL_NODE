import db from '../core/db.js';
import { writeAudit } from './auditService.js';
import { refreshApplicationFeeStatuses } from './admissionFeeObligationService.js';

const clean = value => String(value ?? '').trim();

export function replacementMatricNumber({ admissionYear, acronym, sequenceNumber }) {
  const year = clean(admissionYear).match(/\d{2,4}/)?.[0] || '';
  const yearCode = year.length === 4 ? year.slice(-2) : year;
  const programmeCode = clean(acronym).toUpperCase();
  const sequence = Number(sequenceNumber);
  if (!yearCode || !programmeCode || !Number.isInteger(sequence) || sequence < 1) {
    throw new Error('The replacement matriculation number cannot be generated from the selected programme.');
  }
  return `EKSCOTECH/${yearCode}/${programmeCode}/${String(sequence).padStart(3, '0')}`;
}

async function ensureAliasTable(connection) {
  await connection.query(`CREATE TABLE IF NOT EXISTS matric_number_aliases (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    public_user_id INT NOT NULL,
    applicant_application_id BIGINT NOT NULL,
    matric_number VARCHAR(80) NOT NULL,
    replacement_matric_number VARCHAR(80) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    changed_by INT NULL,
    superseded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_matric_alias_number (matric_number),
    INDEX idx_matric_alias_user (public_user_id),
    INDEX idx_matric_alias_application (applicant_application_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function initializeMatricNumberAliases() {
  return ensureAliasTable(db);
}

export async function changeAdmissionPlacement(req, applicationId, placement) {
  const reason = clean(placement.reason);
  if (reason.length < 10) throw new Error('Enter a clear reason of at least 10 characters for changing the admission placement.');

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await ensureAliasTable(connection);

    const [[application]] = await connection.query(
      `SELECT aa.*,af.session_id,s.name session_name,ad.id decision_id,
              ad.offered_school_id,ad.offered_department_id,ad.offered_programme_id,
              ad.offered_programme_name,t.id transition_id,t.status transition_status,
              pu.matric_number
         FROM applicant_applications aa
         JOIN application_forms af ON af.id=aa.application_form_id
         JOIN sessions s ON s.id=af.session_id
         JOIN admission_decisions ad ON ad.applicant_application_id=aa.id AND ad.status='ADMITTED'
         JOIN applicant_student_transitions t ON t.applicant_application_id=aa.id
         JOIN public_users pu ON pu.id=aa.applicant_user_id
        WHERE aa.id=? LIMIT 1 FOR UPDATE`,
      [applicationId],
    );
    if (!application) throw new Error('An admitted student transition was not found.');

    const [[programme]] = await connection.query(
      `SELECT p.id,p.name,p.acronym,p.school_id,p.department_id,
              d.name department_name,s.name school_name
         FROM programmes p
         JOIN departments d ON d.id=p.department_id
         JOIN schools s ON s.id=p.school_id
        WHERE p.id=? AND p.department_id=? AND p.school_id=? LIMIT 1`,
      [Number(placement.programmeId), Number(placement.departmentId), Number(placement.schoolId)],
    );
    if (!programme) throw new Error('Select a valid programme within the chosen department and school.');
    if (Number(programme.id) === Number(application.offered_programme_id)) {
      throw new Error('The student is already admitted to the selected programme.');
    }

    const [[assignment]] = await connection.query(
      `SELECT * FROM matric_number_assignments WHERE applicant_application_id=? LIMIT 1 FOR UPDATE`,
      [applicationId],
    );
    let newMatricNumber = clean(application.matric_number) || null;
    const oldMatricNumber = clean(assignment?.matric_number || application.matric_number) || null;

    if (assignment) {
      newMatricNumber = replacementMatricNumber({
        admissionYear: assignment.admission_year || application.session_name,
        acronym: programme.acronym,
        sequenceNumber: assignment.sequence_number,
      });
      const [[collision]] = await connection.query(
        `SELECT matric_number FROM matric_number_assignments
          WHERE matric_number=? AND id<>?
         UNION ALL
         SELECT matric_number FROM matric_number_aliases WHERE matric_number=? AND public_user_id<>?
         LIMIT 1`,
        [newMatricNumber, assignment.id, newMatricNumber, application.applicant_user_id],
      );
      if (collision) throw new Error('The replacement matriculation number is already reserved. Contact ICT.');

      if (oldMatricNumber && oldMatricNumber !== newMatricNumber) {
        await connection.query(
          `DELETE FROM matric_number_aliases WHERE public_user_id=? AND matric_number=?`,
          [application.applicant_user_id, newMatricNumber],
        );
        await connection.query(
          `INSERT INTO matric_number_aliases
             (public_user_id,applicant_application_id,matric_number,replacement_matric_number,reason,changed_by)
           VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE replacement_matric_number=VALUES(replacement_matric_number),
             reason=VALUES(reason),changed_by=VALUES(changed_by),superseded_at=NOW()`,
          [application.applicant_user_id, applicationId, oldMatricNumber, newMatricNumber, reason, req.user?.id || null],
        );
        await connection.query(
          `UPDATE matric_number_aliases SET replacement_matric_number=? WHERE public_user_id=?`,
          [newMatricNumber, application.applicant_user_id],
        );
      }
      await connection.query(
        `UPDATE matric_number_assignments
            SET programme_id=?,department_id=?,matric_number=? WHERE id=?`,
        [programme.id, programme.department_id, newMatricNumber, assignment.id],
      );
      await connection.query(`UPDATE public_users SET matric_number=? WHERE id=?`, [newMatricNumber, application.applicant_user_id]);
    }

    await connection.query(
      `UPDATE admission_decisions SET offered_school_id=?,offered_department_id=?,
        offered_programme_id=?,offered_programme_name=?,is_manual_override=1,
        decision_reason=?,admitted_by=?,admitted_at=NOW() WHERE id=?`,
      [programme.school_id, programme.department_id, programme.id, programme.name, reason, req.user?.id || null, application.decision_id],
    );

    let formData = {};
    try { formData = JSON.parse(String(application.form_data || '{}')); } catch {}
    formData.application_details ||= {};
    formData.application_details.programme_choice = {
      ...(formData.application_details.programme_choice || {}),
      school_id: programme.school_id,
      school_name: programme.school_name,
      department_id: programme.department_id,
      department_name: programme.department_name,
      programme_id: programme.id,
      programme_name: programme.name,
    };
    await connection.query(
      `UPDATE applicant_applications SET programme_choice=?,form_data=?,reviewed_by=?,reviewed_at=NOW() WHERE id=?`,
      [programme.name, JSON.stringify(formData), req.user?.id || null, applicationId],
    );
    const [profileUpdate] = await connection.query(
      `UPDATE student_profiles SET school_id=?,department_id=?,programme_id=? WHERE user_id=?`,
      [programme.school_id, programme.department_id, programme.id, application.applicant_user_id],
    );
    if (!Number(profileUpdate.affectedRows)) {
      await connection.query(
        `INSERT INTO student_profiles (user_id,school_id,department_id,programme_id,level,phone,status)
         SELECT pu.id,?,?,?,'100',pu.phone,'INCOMPLETE' FROM public_users pu WHERE pu.id=?`,
        [programme.school_id, programme.department_id, programme.id, application.applicant_user_id],
      );
    }
    await connection.query(
      `UPDATE applicant_student_transitions SET admission_decision_id=? WHERE id=?`,
      [application.decision_id, application.transition_id],
    );
    await connection.query(
      `UPDATE issued_admission_documents SET status='REVOKED',revoked_at=NOW()
        WHERE applicant_application_id=? AND document_type IN ('ADMISSION_NOTIFICATION','ADMISSION_LETTER') AND status='VALID'`,
      [applicationId],
    );
    await connection.query(
      `INSERT INTO portal_notifications
         (public_user_id,applicant_application_id,notification_type,title,message,action_url)
       VALUES (?,?,'ADMISSION_PLACEMENT_CHANGED','Your admission placement was updated',?, '/applicant/admission/status')`,
      [
        application.applicant_user_id,
        applicationId,
        `Your admission placement is now ${programme.name}. ${newMatricNumber && newMatricNumber !== oldMatricNumber ? `Your active matriculation number is ${newMatricNumber}.` : ''}`.trim(),
      ],
    );
    const feeSummary = await refreshApplicationFeeStatuses(applicationId, connection);
    await writeAudit(connection, req, {
      action: 'ADMISSION_PLACEMENT_CHANGED_AFTER_MATRICULATION',
      entityType: 'applicant_application',
      entityId: applicationId,
      reason,
      oldValues: {
        school_id: application.offered_school_id,
        department_id: application.offered_department_id,
        programme_id: application.offered_programme_id,
        programme_name: application.offered_programme_name,
        matric_number: oldMatricNumber,
      },
      newValues: {
        school_id: programme.school_id,
        department_id: programme.department_id,
        programme_id: programme.id,
        programme_name: programme.name,
        matric_number: newMatricNumber,
        old_matric_reserved: Boolean(oldMatricNumber && oldMatricNumber !== newMatricNumber),
      },
    });
    await connection.commit();
    return {
      oldMatricNumber,
      newMatricNumber,
      programmeName: programme.name,
      acceptanceOutstanding: feeSummary?.acceptance?.outstanding || 0,
      compulsoryOutstanding: feeSummary?.compulsory?.outstanding || 0,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

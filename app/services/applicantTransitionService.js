import db from "../core/db.js";
import { allocateMatriculation } from './matriculationService.js';

export async function tryGrantStudentAccessForOrder(orderId) {
  const connection=await db.getConnection();
  try{
    await connection.beginTransaction();
    const [[invoice]]=await connection.query(`SELECT pi.*,pt.name payment_type_name,pt.purpose payment_type_purpose,pt.is_compulsory FROM payment_invoices pi JOIN payment_types pt ON pt.id=pi.payment_type_id WHERE pi.order_id=? AND pi.status='PAID' LIMIT 1 FOR UPDATE`,[orderId]);
    if(!invoice){await connection.commit();return {transitioned:false,reason:"Invoice is not confirmed paid."};}
    const descriptor=`${invoice.payment_type_name||""} ${invoice.payment_type_purpose||""} ${invoice.purpose||""}`.toLowerCase();
    if(!Number(invoice.is_compulsory)&&!descriptor.includes("compulsory")){await connection.commit();return {transitioned:false,reason:"Payment is not marked as a compulsory fee."};}
    const [applications]=await connection.query(
      `SELECT aa.*,ad.id decision_id,ad.offered_school_id,ad.offered_department_id,ad.offered_programme_id,af.session_id
       FROM applicant_applications aa JOIN admission_decisions ad ON ad.applicant_application_id=aa.id AND ad.status='ADMITTED'
       JOIN application_forms af ON af.id=aa.application_form_id JOIN public_users pu ON pu.id=aa.applicant_user_id
       WHERE aa.acceptance_payment_status='PAID' AND (CAST(aa.applicant_user_id AS CHAR)=TRIM(?) OR pu.username=TRIM(?) OR pu.matric_number=TRIM(?))
       ORDER BY aa.id DESC LIMIT 1 FOR UPDATE`,[invoice.payee_id,invoice.payee_email,invoice.payee_id]);
    const application=applications[0];if(!application){await connection.commit();return {transitioned:false,reason:"No admitted applicant with confirmed acceptance payment matched this invoice."};}
    const [[existing]]=await connection.query(`SELECT * FROM applicant_student_transitions WHERE applicant_application_id=? LIMIT 1`,[application.id]);
    if(existing){await connection.commit();return {transitioned:false,existing:true,transition:existing};}
    const [result]=await connection.query(`INSERT INTO applicant_student_transitions (applicant_application_id,public_user_id,admission_decision_id,acceptance_invoice_id,compulsory_invoice_id,status) VALUES (?,?,?,?,?,'PENDING_MATRICULATION')`,[application.id,application.applicant_user_id,application.decision_id,application.acceptance_invoice_id,invoice.id]);
    await connection.query(`INSERT IGNORE INTO portal_user_roles (public_user_id,role,granted_by) VALUES (?,'applicant',NULL),(?,'student',NULL)`,[application.applicant_user_id,application.applicant_user_id]);
    await connection.query(`INSERT INTO student_profiles (user_id,school_id,department_id,programme_id,level,phone,status) SELECT pu.id,?,?,?,'100',pu.phone,'INCOMPLETE' FROM public_users pu WHERE pu.id=? AND NOT EXISTS (SELECT 1 FROM student_profiles sp WHERE sp.user_id=pu.id)`,[application.offered_school_id,application.offered_department_id,application.offered_programme_id,application.applicant_user_id]);
    await connection.query(`INSERT INTO portal_notifications (public_user_id,applicant_application_id,notification_type,title,message,action_url) VALUES (?,?,'STUDENT_ACCESS_GRANTED','Student Portal access is ready','Your compulsory fee has been confirmed and Student Portal access has been added to your account. Your Applicant Portal remains available.','/portal/choose')`,[application.applicant_user_id,application.id]);
    await connection.query(`INSERT INTO portal_audit_log (action,entity_type,entity_id,new_values) VALUES ('STUDENT_ACCESS_GRANTED','applicant_application',?,?)`,[String(application.id),JSON.stringify({transition_id:result.insertId,matriculation:"PENDING_MATRICULATION"})]);
    let matriculation=null;try{matriculation=await allocateMatriculation(connection,application.id);}catch(error){if(!/not enabled|department code/i.test(error.message))throw error;}
    await connection.commit();return {transitioned:true,transitionId:result.insertId,matriculation};
  }catch(error){await connection.rollback();throw error;}finally{connection.release();}
}

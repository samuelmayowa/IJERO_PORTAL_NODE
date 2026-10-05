import db from '../core/db.js';

function yearCode(sessionName){const match=String(sessionName||'').match(/(\d{4})/);if(!match)throw new Error('The academic session has no valid starting year.');return match[1].slice(-2)}

export async function allocateMatriculation(connection,applicationId){
  const [[app]]=await connection.query(`SELECT aa.id,aa.applicant_user_id,af.session_id,s.name session_name,ad.offered_department_id,ad.offered_programme_id,p.acronym programme_acronym,t.id transition_id,t.status transition_status FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN sessions s ON s.id=af.session_id JOIN admission_decisions ad ON ad.applicant_application_id=aa.id AND ad.status='ADMITTED' JOIN applicant_student_transitions t ON t.applicant_application_id=aa.id LEFT JOIN programmes p ON p.id=ad.offered_programme_id WHERE aa.id=? LIMIT 1 FOR UPDATE`,[applicationId]);
  if(!app)throw new Error('An admitted, transitioned applicant was not found.');
  const [[existing]]=await connection.query(`SELECT * FROM matric_number_assignments WHERE applicant_application_id=? LIMIT 1`,[applicationId]);if(existing)return existing;
  const code=String(app.programme_acronym||'').trim().toUpperCase();if(!code)throw new Error('Configure a unique programme acronym before generating this matriculation number.');
  await connection.query(`INSERT IGNORE INTO matric_number_sequences (session_id,programme_id,department_id,last_number) VALUES (?,0,0,0)`,[app.session_id]);
  const [[sequence]]=await connection.query(`SELECT * FROM matric_number_sequences WHERE session_id=? FOR UPDATE`,[app.session_id]);
  const next=Number(sequence.last_number)+1;const matric=`EKSCOTECH/${yearCode(app.session_name)}/${code}/${String(next).padStart(3,'0')}`;
  const [result]=await connection.query(`INSERT INTO matric_number_assignments (applicant_application_id,public_user_id,session_id,admission_year,programme_id,department_id,sequence_number,matric_number) VALUES (?,?,?,?,?,?,?,?)`,[app.id,app.applicant_user_id,app.session_id,yearCode(app.session_name),app.offered_programme_id,app.offered_department_id,next,matric]);
  await connection.query(`UPDATE matric_number_sequences SET last_number=? WHERE id=?`,[next,sequence.id]);
  await connection.query(`UPDATE public_users SET matric_number=? WHERE id=?`,[matric,app.applicant_user_id]);
  await connection.query(`UPDATE applicant_student_transitions SET status='COMPLETED',completed_at=NOW() WHERE id=?`,[app.transition_id]);
  await connection.query(`INSERT INTO portal_notifications (public_user_id,applicant_application_id,notification_type,title,message,action_url) VALUES (?,?,'MATRIC_NUMBER_ASSIGNED','Your matriculation number is ready',?,'/portal/choose')`,[app.applicant_user_id,app.id,`Your matriculation number is ${matric}. Your Applicant Portal remains available alongside your Student Portal.`]);
  await connection.query(`INSERT INTO portal_audit_log (action,entity_type,entity_id,new_values) VALUES ('MATRIC_NUMBER_ASSIGNED','applicant_application',?,?)`,[String(app.id),JSON.stringify({assignment_id:result.insertId,matric_number:matric,session_sequence:next})]);
  return {id:result.insertId,matric_number:matric,sequence_number:next};
}

export async function generateMatriculation(applicationId){const connection=await db.getConnection();try{await connection.beginTransaction();const result=await allocateMatriculation(connection,applicationId);await connection.commit();return result}catch(error){await connection.rollback();throw error}finally{connection.release()}}

export async function ensureMatriculationForPublicUser(publicUserId){
  const [[pending]]=await db.query(`SELECT t.applicant_application_id FROM applicant_student_transitions t JOIN applicant_applications aa ON aa.id=t.applicant_application_id LEFT JOIN matric_number_assignments ma ON ma.applicant_application_id=aa.id WHERE t.public_user_id=? AND aa.compulsory_payment_status='PAID' AND ma.id IS NULL ORDER BY t.id DESC LIMIT 1`,[publicUserId]);
  if(!pending)return null;
  return generateMatriculation(pending.applicant_application_id);
}

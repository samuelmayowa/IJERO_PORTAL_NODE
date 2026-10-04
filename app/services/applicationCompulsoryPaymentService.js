import db from '../core/db.js';
import {createInvoice,getPaymentType} from './paymentService.js';

const clean=value=>String(value??'').trim();
const money=value=>Number.isFinite(Number(value))?Number(value):0;
const fullName=user=>[user?.first_name,user?.middle_name,user?.last_name].map(clean).filter(Boolean).join(' ');
const email=user=>clean(user?.email)||(clean(user?.username).includes('@')?clean(user.username):'no-reply@ekscotech.edu.ng');
function phone(value){let digits=clean(value).replace(/\D+/g,'');if(digits.startsWith('234')&&digits.length===13)digits=`0${digits.slice(3)}`;if(digits.length===10&&!digits.startsWith('0'))digits=`0${digits}`;return digits||'00000000000'}

export async function listCompulsoryApplications(applicantUserId){
  const [rows]=await db.query(`SELECT aa.id,aa.application_number,aa.status application_status,aa.acceptance_payment_status,aa.compulsory_payment_status,aa.compulsory_invoice_id,af.title application_title,af.category,af.compulsory_payment_type_id,pt.name compulsory_payment_type,pt.is_active compulsory_payment_type_active,pt.is_compulsory,pt.remita_service_type_id,pi.order_id,pi.rrr,pi.status invoice_status,pi.paid_at,COALESCE((SELECT SUM(r.amount) FROM programme_compulsory_fee_rules r WHERE r.application_form_id=aa.application_form_id AND r.programme_id=ad.offered_programme_id AND r.is_active=1),(SELECT SUM(c.amount) FROM application_form_charges c WHERE c.application_form_id=aa.application_form_id AND c.charge_stage='COMPULSORY' AND c.is_active=1),0) configured_compulsory_total FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id LEFT JOIN admission_decisions ad ON ad.applicant_application_id=aa.id AND ad.status='ADMITTED' LEFT JOIN payment_types pt ON pt.id=af.compulsory_payment_type_id LEFT JOIN payment_invoices pi ON pi.id=aa.compulsory_invoice_id WHERE aa.applicant_user_id=? AND (aa.status='ADMITTED' OR aa.acceptance_payment_status='PAID' OR aa.compulsory_invoice_id IS NOT NULL) ORDER BY aa.id DESC`,[applicantUserId]);return rows||[];
}

async function compulsoryCharges(connection,application){
  const [scoped]=await connection.query(`SELECT NULL id,charge_name,amount FROM programme_compulsory_fee_rules WHERE application_form_id=? AND programme_id=? AND is_active=1 ORDER BY id`,[application.application_form_id,application.offered_programme_id||0]);
  if(scoped.length)return scoped;
  const [legacy]=await connection.query(`SELECT id,charge_name,amount FROM application_form_charges WHERE application_form_id=? AND charge_stage='COMPULSORY' AND is_active=1 ORDER BY display_order,id`,[application.application_form_id]);
  return legacy;
}

async function replaceLines(connection,application,invoiceId){
  const charges=await compulsoryCharges(connection,application);
  const total=charges.reduce((sum,row)=>sum+money(row.amount),0);if(total<=0)throw new Error('No payable compulsory fee has been configured for this application.');
  await connection.query(`DELETE FROM application_payment_lines WHERE applicant_application_id=? AND charge_stage='COMPULSORY'`,[application.id]);
  for(const charge of charges)await connection.query(`INSERT INTO application_payment_lines (applicant_application_id,application_form_charge_id,invoice_id,charge_stage,charge_name,amount,payment_status) VALUES (?,?,?,'COMPULSORY',?,?,?)`,[application.id,charge.id,invoiceId,clean(charge.charge_name),money(charge.amount),money(charge.amount)>0?'PENDING':'NO_CHARGE']);
  return total;
}

export async function startOrResumeCompulsoryPayment({applicationId,applicant}){
  const userId=Number(applicant?.id);if(!userId)throw new Error('The applicant account could not be identified.');
  const [[application]]=await db.query(`SELECT aa.*,af.title application_title,af.compulsory_payment_type_id,ad.offered_programme_id FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id LEFT JOIN admission_decisions ad ON ad.applicant_application_id=aa.id AND ad.status='ADMITTED' WHERE aa.id=? AND aa.applicant_user_id=? LIMIT 1`,[applicationId,userId]);
  if(!application)throw new Error('The application was not found.');
  if(clean(application.acceptance_payment_status).toUpperCase()!=='PAID')throw new Error('Acceptance fee payment is required before compulsory-fee payment.');
  const paymentType=await getPaymentType(application.compulsory_payment_type_id);if(!paymentType||Number(paymentType.is_active)!==1)throw new Error('The compulsory-fee payment type has not been configured.');
  if(!Number(paymentType.is_compulsory))throw new Error('The selected payment type must be marked as a compulsory fee obligation.');
  const stid=clean(paymentType.remita_service_type_id);if(!stid)throw new Error('The selected compulsory-fee payment type does not have a Remita STID.');
  if(application.compulsory_invoice_id){const [[invoice]]=await db.query(`SELECT * FROM payment_invoices WHERE id=? LIMIT 1`,[application.compulsory_invoice_id]);if(invoice){if(clean(invoice.status).toUpperCase()==='PAID'){await db.query(`UPDATE applicant_applications SET compulsory_payment_status='PAID' WHERE id=?`,[application.id]);return {orderId:invoice.order_id,status:'PAID'}}const connection=await db.getConnection();try{await connection.beginTransaction();const total=await replaceLines(connection,application,invoice.id);const changed=money(invoice.amount)!==total||Number(invoice.payment_type_id)!==Number(paymentType.id)||clean(invoice.remita_service_type_id)!==stid;await connection.query(`UPDATE payment_invoices SET payment_type_id=?,purpose=?,amount=?,portal_charge=0,remita_service_type_id=?,status='PENDING',rrr=CASE WHEN ?=1 THEN NULL ELSE rrr END,payment_meta=CASE WHEN ?=1 THEN NULL ELSE payment_meta END WHERE id=?`,[paymentType.id,`${application.application_title} - Compulsory Fees`,total,stid,changed?1:0,changed?1:0,invoice.id]);await connection.query(`UPDATE applicant_applications SET compulsory_payment_status='PENDING' WHERE id=?`,[application.id]);await connection.commit();return {orderId:invoice.order_id,status:'PENDING'}}catch(error){await connection.rollback();throw error}finally{connection.release()}}}
  const charges=await compulsoryCharges(db,application);const total=charges.reduce((sum,row)=>sum+money(row.amount),0);if(total<=0)throw new Error('No payable compulsory fee has been configured for this programme.');
  const created=await createInvoice({payment_type_id:paymentType.id,payee_id:clean(applicant.username)||String(userId),payee_fullname:fullName(applicant)||'Applicant',payee_email:email(applicant),payee_phone:phone(applicant.phone),purpose:`${application.application_title} - Compulsory Fees`,amount:total,portal_charge_override:0,method:'ONLINE'});
  const connection=await db.getConnection();try{await connection.beginTransaction();await connection.query(`UPDATE payment_invoices SET remita_service_type_id=?,created_by=? WHERE id=?`,[stid,userId,created.id]);await connection.query(`UPDATE applicant_applications SET compulsory_invoice_id=?,compulsory_payment_status='PENDING' WHERE id=?`,[created.id,application.id]);await replaceLines(connection,application,created.id);await connection.commit()}catch(error){await connection.rollback();throw error}finally{connection.release()}
  return {orderId:created.order_id,status:'PENDING'};
}

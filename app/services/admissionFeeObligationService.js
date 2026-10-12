import db from '../core/db.js';

const money=value=>Math.round((Number(value)||0)*100)/100;

async function applicationContext(executor,applicationId,userId=null){
  const params=[applicationId];let owner='';if(userId){owner=' AND aa.applicant_user_id=?';params.push(userId)}
  const [[row]]=await executor.query(`SELECT aa.*,af.title application_title,af.session_id,af.application_payment_type_id,af.acceptance_payment_type_id,af.compulsory_payment_type_id,ad.offered_programme_id,p.name programme_name FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id LEFT JOIN admission_decisions ad ON ad.applicant_application_id=aa.id AND ad.status='ADMITTED' LEFT JOIN programmes p ON p.id=ad.offered_programme_id WHERE aa.id=?${owner} LIMIT 1`,params);
  return row||null;
}

async function expectedCharges(executor,application,stage){
  const table=stage==='ACCEPTANCE'?'programme_acceptance_fee_rules':'programme_compulsory_fee_rules';
  if(application.offered_programme_id){const [scoped]=await executor.query(`SELECT id,charge_name,amount FROM ${table} WHERE application_form_id=? AND programme_id=? AND is_active=1 ORDER BY id`,[application.application_form_id,application.offered_programme_id]);if(scoped.length)return scoped.map(x=>({...x,source:'PROGRAMME'}));}
  const [fallback]=await executor.query(`SELECT id,charge_name,amount FROM application_form_charges WHERE application_form_id=? AND charge_stage=? AND is_active=1 ORDER BY display_order,id`,[application.application_form_id,stage]);
  return fallback.map(x=>({...x,source:'APPLICATION_TYPE'}));
}

async function stagePayments(executor,application,stage){
  const primaryId=stage==='APPLICATION'?application.application_invoice_id:stage==='ACCEPTANCE'?application.acceptance_invoice_id:application.compulsory_invoice_id;
  const params=[primaryId||0,application.id,stage];
  const [rows]=await executor.query(`SELECT DISTINCT pi.id,pi.order_id,pi.amount,pi.portal_charge,pi.status,pi.paid_at,pi.created_at,pi.purpose FROM payment_invoices pi WHERE pi.id=? OR pi.id IN (SELECT v.invoice_id FROM application_fee_variation_invoices v WHERE v.applicant_application_id=? AND v.fee_stage=?) ORDER BY COALESCE(pi.paid_at,pi.created_at),pi.id`,params);
  return rows;
}

export async function getApplicationFeeSummary(applicationId,userId=null,executor=db){
  const application=await applicationContext(executor,applicationId,userId);if(!application)return null;
  const result={context:application};
  for(const stage of ['APPLICATION','ACCEPTANCE','COMPULSORY']){
    const charges=stage==='APPLICATION'?(await executor.query(`SELECT id,charge_name,amount FROM application_form_charges WHERE application_form_id=? AND charge_stage='APPLICATION' AND is_active=1 ORDER BY display_order,id`,[application.application_form_id]))[0]:await expectedCharges(executor,application,stage);
    const payments=await stagePayments(executor,application,stage);const expected=money(charges.reduce((s,x)=>s+money(x.amount),0));const paid=money(payments.filter(x=>x.status==='PAID').reduce((s,x)=>s+money(x.amount),0));
    result[stage.toLowerCase()]={stage,charges,payments,expected,paid,outstanding:money(Math.max(0,expected-paid)),credit:money(Math.max(0,paid-expected))};
  }
  result.totalOutstanding=money(result.application.outstanding+result.acceptance.outstanding+result.compulsory.outstanding);
  result.totalCredit=money(result.application.credit+result.acceptance.credit+result.compulsory.credit);
  return result;
}

export async function refreshApplicationFeeStatuses(applicationId,executor=db){
  const summary=await getApplicationFeeSummary(applicationId,null,executor);if(!summary)return null;
  const state=part=>part.outstanding<=0?'PAID':part.payments.some(x=>x.status==='PENDING')?'PENDING':'UNPAID';
  await executor.query(`UPDATE applicant_applications SET acceptance_payment_status=?,compulsory_payment_status=? WHERE id=?`,[state(summary.acceptance),state(summary.compulsory),applicationId]);
  return summary;
}

export async function latestPendingVariation(applicationId,stage,executor=db){const [[row]]=await executor.query(`SELECT v.*,pi.order_id,pi.status invoice_status FROM application_fee_variation_invoices v JOIN payment_invoices pi ON pi.id=v.invoice_id WHERE v.applicant_application_id=? AND v.fee_stage=? AND pi.status='PENDING' ORDER BY v.id DESC LIMIT 1`,[applicationId,stage]);return row||null}

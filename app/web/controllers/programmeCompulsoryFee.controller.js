import { pool } from "../../core/db.js";
import { writeAudit } from "../../services/auditService.js";

const clean=value=>String(value??"").trim();
const id=value=>Number.parseInt(value,10)||0;

export async function page(req,res,next){
  try{
    const [[forms],[schools],[departments],[programmes],[rules]]=await Promise.all([
      pool.query(`SELECT af.id,af.title,af.session_id,s.name session_name FROM application_forms af JOIN sessions s ON s.id=af.session_id ORDER BY af.id DESC`),
      pool.query(`SELECT id,name FROM schools ORDER BY name`),
      pool.query(`SELECT id,school_id,name FROM departments ORDER BY name`),
      pool.query(`SELECT p.id,p.school_id,p.department_id,p.name,p.acronym FROM programmes p ORDER BY p.name`),
      pool.query(`SELECT r.*,p.name programme_name,p.school_id,p.department_id,af.title application_title,s.name session_name FROM programme_compulsory_fee_rules r JOIN programmes p ON p.id=r.programme_id JOIN application_forms af ON af.id=r.application_form_id JOIN sessions s ON s.id=af.session_id WHERE r.is_active=1 ORDER BY r.application_form_id,p.name,r.id`),
    ]);
    res.render("pages/staff/programme-compulsory-fees",{layout:"layouts/adminlte",title:"Programme Compulsory Fees",pageTitle:"Programme Compulsory Fees",forms,schools,departments,programmes,rules});
  }catch(error){next(error)}
}

export async function save(req,res){
  const connection=await pool.getConnection();
  try{
    const formId=id(req.body.application_form_id);if(!formId)throw new Error("Select an application type.");
    const [[form]]=await connection.query(`SELECT id,compulsory_payment_type_id FROM application_forms WHERE id=? LIMIT 1`,[formId]);if(!form)throw new Error("Application type not found.");if(!form.compulsory_payment_type_id)throw new Error("Select a compulsory-fee Remita payment type on the application form first.");
    const names=Array.isArray(req.body.charge_name)?req.body.charge_name:[req.body.charge_name];
    const amounts=Array.isArray(req.body.charge_amount)?req.body.charge_amount:[req.body.charge_amount];
    const charges=names.map((name,index)=>({name:clean(name),amount:Number(amounts[index])})).filter(x=>x.name&&Number.isFinite(x.amount)&&x.amount>=0);
    if(!charges.length)throw new Error("Add at least one valid compulsory-fee charge.");
    let programmeIds=(Array.isArray(req.body.programme_ids)?req.body.programme_ids:[req.body.programme_ids]).map(id).filter(Boolean);
    if(req.body.apply_all){const [available]=await connection.query(`SELECT p.id FROM programmes p WHERE NOT EXISTS (SELECT 1 FROM programme_compulsory_fee_rules r WHERE r.application_form_id=? AND r.programme_id=p.id AND r.is_active=1)`,[formId]);programmeIds=available.map(x=>x.id);}
    programmeIds=[...new Set(programmeIds)];if(!programmeIds.length)throw new Error(req.body.apply_all?"Every programme already has a compulsory fee for this application type.":"Select at least one programme.");
    await connection.beginTransaction();
    for(const programmeId of programmeIds){
      const [[programme]]=await connection.query(`SELECT id FROM programmes WHERE id=? LIMIT 1`,[programmeId]);if(!programme)throw new Error("One selected programme no longer exists.");
      await connection.query(`UPDATE programme_compulsory_fee_rules SET is_active=0,updated_by=? WHERE application_form_id=? AND programme_id=?`,[req.user?.id||null,formId,programmeId]);
      for(const charge of charges)await connection.query(`INSERT INTO programme_compulsory_fee_rules (application_form_id,programme_id,charge_name,amount,created_by,updated_by) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount),is_active=1,updated_by=VALUES(updated_by)`,[formId,programmeId,charge.name,charge.amount,req.user?.id||null,req.user?.id||null]);
    }
    await writeAudit(connection,req,{action:"PROGRAMME_COMPULSORY_FEES_CONFIGURED",entityType:"application_form",entityId:formId,newValues:{programme_ids:programmeIds,charges}});
    await connection.commit();req.flash("success",`Compulsory fees saved for ${programmeIds.length} programme(s).`);
  }catch(error){await connection.rollback();req.flash("error",error.message||"Compulsory fees could not be saved.");}finally{connection.release()}
  res.redirect("/staff/fees/programme-compulsory-fees");
}

export async function remove(req,res){
  try{await pool.query(`UPDATE programme_compulsory_fee_rules SET is_active=0,updated_by=? WHERE id=?`,[req.user?.id||null,id(req.params.id)]);req.flash("success","Compulsory-fee charge removed.");}catch(error){req.flash("error",error.message||"The charge could not be removed.");}
  res.redirect("/staff/fees/programme-compulsory-fees");
}

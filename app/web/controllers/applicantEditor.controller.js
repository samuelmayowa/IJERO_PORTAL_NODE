import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { pool } from "../../core/db.js";
import { writeAudit } from "../../services/auditService.js";

const clean=value=>String(value??"").trim();
const id=value=>Number.parseInt(value,10)||0;
function parsed(value){try{return value&&typeof value==="object"?value:JSON.parse(String(value||"{}"));}catch{return {};}}

async function applicant(applicationId){
  const [rows]=await pool.query(`SELECT aa.*,pu.first_name,pu.middle_name,pu.last_name,pu.username,pu.role,pu.dob,pu.gender,pu.phone,pu.address,pu.state_of_origin,pu.lga,af.title application_title,s.name session_name FROM applicant_applications aa JOIN public_users pu ON pu.id=aa.applicant_user_id JOIN application_forms af ON af.id=aa.application_form_id JOIN sessions s ON s.id=af.session_id WHERE aa.id=? AND pu.role='applicant' LIMIT 1`,[applicationId]);
  return rows[0]||null;
}

export async function editPage(req,res,next){
  try{
    const application=await applicant(id(req.params.id));if(!application)return res.status(404).send("Applicant application not found.");
    const [[schools],[departments],[programmes],[documents],[audits]]=await Promise.all([
      pool.query(`SELECT id,name FROM schools ORDER BY name`),pool.query(`SELECT id,school_id,name FROM departments ORDER BY name`),pool.query(`SELECT id,school_id,department_id,name FROM programmes ORDER BY name`),
      pool.query(`SELECT id,original_filename,mime_type,created_at FROM application_documents WHERE applicant_application_id=? AND document_type='PASSPORT' AND is_current=1 AND deleted_at IS NULL ORDER BY id DESC`,[application.id]),
      pool.query(`SELECT * FROM portal_audit_log WHERE entity_type='applicant_application' AND entity_id=? ORDER BY id DESC LIMIT 30`,[String(application.id)]),
    ]);
    const data=parsed(application.form_data),choice=data?.application_details?.programme_choice||{};
    res.render("pages/staff/applicant-edit",{layout:"layouts/adminlte",title:"Edit Applicant",pageTitle:"Edit Applicant",application,choice,olevel:data?.application_details?.olevel||{},schools,departments,programmes,documents,audits});
  }catch(error){next(error);}
}

export async function updateApplicant(req,res){
  const applicationId=id(req.params.id),reason=clean(req.body.reason);const connection=await pool.getConnection();
  try{
    if(!reason)throw new Error("A correction reason is required.");
    await connection.beginTransaction();
    const application=await applicant(applicationId);if(!application)throw new Error("Applicant application not found.");
    const schoolId=id(req.body.school_id),departmentId=id(req.body.department_id),programmeId=id(req.body.programme_id);
    const [[programme]]=await connection.query(`SELECT p.*,d.name department_name,s.name school_name FROM programmes p JOIN departments d ON d.id=p.department_id JOIN schools s ON s.id=p.school_id WHERE p.id=? AND p.department_id=? AND p.school_id=? LIMIT 1`,[programmeId,departmentId,schoolId]);
    if(!programme)throw new Error("The selected programme does not belong to the selected department and school.");
    const firstName=clean(req.body.first_name),lastName=clean(req.body.last_name),middleName=clean(req.body.middle_name);
    if(!firstName||!lastName)throw new Error("First name and surname are required.");
    const email=clean(req.body.email).toLowerCase();if(!email)throw new Error("Email is required.");
    const [[duplicateEmail]]=await connection.query(`SELECT id FROM public_users WHERE username=? AND id<>? LIMIT 1`,[email,application.applicant_user_id]);if(duplicateEmail)throw new Error("That email already belongs to another portal account.");
    const data=parsed(application.form_data);data.application_details=data.application_details||{};data.application_details.programme_choice={...(data.application_details.programme_choice||{}),school_id:schoolId,school_name:programme.school_name,department_id:departmentId,department_name:programme.department_name,programme_id:programmeId,programme_name:programme.name};
    const subjectKeys=['english_language','mathematics','biology','physics','chemistry','economics','agricultural_science','geography','civic_education'];
    const sittingCount=clean(req.body.olevel_sitting_count)==='2'?2:1,sittings=[];
    for(let number=1;number<=sittingCount;number+=1){const subjects={};for(const key of subjectKeys)subjects[key]=clean(req.body[`sitting_${number}_${key}`]).toUpperCase();sittings.push({sitting_number:number,examination_type:clean(req.body[`sitting_${number}_exam_type`]).toUpperCase(),examination_number:clean(req.body[`sitting_${number}_exam_number`]).toUpperCase(),examination_year:clean(req.body[`sitting_${number}_exam_year`]),subjects});}
    data.application_details.olevel={sitting_count:sittingCount,sittings};
    await connection.query(`UPDATE public_users SET first_name=?,middle_name=?,last_name=?,username=?,dob=?,gender=?,phone=?,address=?,state_of_origin=?,lga=? WHERE id=? AND role='applicant'`,[firstName,middleName||null,lastName,email,clean(req.body.dob)||null,clean(req.body.gender)||null,clean(req.body.phone)||null,clean(req.body.address)||null,clean(req.body.state_of_origin)||null,clean(req.body.lga)||null,application.applicant_user_id]);
    await connection.query(`UPDATE applicant_applications SET programme_choice=?,form_data=? WHERE id=?`,[programme.name,JSON.stringify(data),applicationId]);
    await writeAudit(connection,req,{action:"APPLICANT_RECORD_CORRECTED",entityType:"applicant_application",entityId:applicationId,reason,oldValues:{first_name:application.first_name,middle_name:application.middle_name,last_name:application.last_name,email:application.username,programme_choice:application.programme_choice},newValues:{first_name:firstName,middle_name:middleName,last_name:lastName,email,school_id:schoolId,department_id:departmentId,programme_id:programmeId,programme_choice:programme.name,olevel:data.application_details.olevel}});
    await connection.commit();req.flash("success","Applicant record corrected successfully.");
  }catch(error){await connection.rollback();req.flash("error",error.message||"Unable to correct applicant record.");}
  finally{connection.release();}
  res.redirect(`/staff/admissions/applicants/${applicationId}/edit`);
}

function validImage(buffer,mime){
  if(!Buffer.isBuffer(buffer))return false;
  if(mime==="image/png")return buffer.length>8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  return mime==="image/jpeg"&&buffer.length>3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
}

export async function replacePassport(req,res){
  const applicationId=id(req.params.id),reason=clean(req.body.reason);const connection=await pool.getConnection();
  try{
    if(!reason)throw new Error("A passport replacement reason is required.");
    if(!req.file||!validImage(req.file.buffer,req.file.mimetype))throw new Error("The selected file is not a valid JPG or PNG image.");
    const application=await applicant(applicationId);if(!application)throw new Error("Applicant application not found.");
    const extension=req.file.mimetype==="image/png"?".png":".jpg",hash=crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const directory=path.resolve("app/uploads/applications",String(applicationId));await fs.mkdir(directory,{recursive:true});
    const stored=`passport-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`,storagePath=path.join(directory,stored);
    await fs.writeFile(storagePath,req.file.buffer,{flag:"wx"});
    try{
      await connection.beginTransaction();
      const [[old]]=await connection.query(`SELECT id,original_filename,file_hash FROM application_documents WHERE applicant_application_id=? AND document_type='PASSPORT' AND is_current=1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`,[applicationId]);
      await connection.query(`UPDATE application_documents SET is_current=0,replaced_at=NOW() WHERE applicant_application_id=? AND document_type='PASSPORT' AND is_current=1`,[applicationId]);
      const [result]=await connection.query(`INSERT INTO application_documents (applicant_application_id,document_type,document_label,original_filename,stored_filename,storage_path,mime_type,file_extension,size_bytes,file_hash,uploaded_by_applicant_user_id) VALUES (?,'PASSPORT','Passport Photograph',?,?,?,?,?,?,?,?)`,[applicationId,path.basename(req.file.originalname),stored,storagePath,req.file.mimetype,extension,req.file.size,hash,application.applicant_user_id]);
      await writeAudit(connection,req,{action:"APPLICANT_PASSPORT_REPLACED",entityType:"applicant_application",entityId:applicationId,reason,oldValues:old||null,newValues:{document_id:result.insertId,original_filename:path.basename(req.file.originalname),file_hash:hash}});
      await connection.commit();req.flash("success","Passport photograph replaced successfully.");
    }catch(error){await connection.rollback();await fs.unlink(storagePath).catch(()=>{});throw error;}
  }catch(error){req.flash("error",error.message||"Unable to replace passport photograph.");}
  finally{connection.release();}
  res.redirect(`/staff/admissions/applicants/${applicationId}/edit`);
}

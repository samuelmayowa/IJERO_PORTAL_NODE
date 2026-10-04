import bcrypt from "bcryptjs";
import { pool } from "../../core/db.js";
import { writeAudit } from "../../services/auditService.js";

const clean=value=>String(value??"").trim();
const id=value=>Number.parseInt(value,10)||0;
const allowedTypes=new Set(["staff","student","applicant"]);
const typeOf=req=>allowedTypes.has(clean(req.params.type||req.query.type).toLowerCase())?clean(req.params.type||req.query.type).toLowerCase():"student";

async function users(type,q,page,pageSize=25){
  const offset=(page-1)*pageSize,term=`%${q}%`;
  if(type==="staff"){
    const where=q?`WHERE s.staff_no LIKE ? OR s.username LIKE ? OR s.email LIKE ? OR s.phone LIKE ? OR s.full_name LIKE ?`:"",params=q?[term,term,term,term,term]:[];
    const [[count],[rows]]=await Promise.all([pool.query(`SELECT COUNT(*) total FROM staff s ${where}`,params),pool.query(`SELECT s.id,s.staff_no identifier,s.full_name name,COALESCE(s.email,s.username) email,s.phone,s.status FROM staff s ${where} ORDER BY s.full_name LIMIT ? OFFSET ?`,[...params,pageSize,offset])]);return {rows,total:Number(count[0]?.total||0)};
  }
  const where=[`pu.role=?`],params=[type];if(q){where.push(`(pu.matric_number LIKE ? OR pu.username LIKE ? OR pu.phone LIKE ? OR CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) LIKE ?)`);params.push(term,term,term,term)}
  const clause=`WHERE ${where.join(" AND ")}`;const [[count],[rows]]=await Promise.all([pool.query(`SELECT COUNT(*) total FROM public_users pu ${clause}`,params),pool.query(`SELECT pu.id,COALESCE(pu.matric_number,'') identifier,CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) name,pu.username email,pu.phone,pu.status FROM public_users pu ${clause} ORDER BY pu.last_name,pu.first_name LIMIT ? OFFSET ?`,[...params,pageSize,offset])]);return {rows,total:Number(count[0]?.total||0)};
}

export async function page(req,res,next){try{const type=typeOf(req),q=clean(req.query.q).slice(0,100),page=Math.max(1,id(req.query.page)||1),result=await users(type,q,page);res.render("pages/staff/password-management",{layout:"layouts/adminlte",title:`${type[0].toUpperCase()+type.slice(1)} Passwords`,pageTitle:"Manage Passwords",type,q,page,totalPages:Math.max(1,Math.ceil(result.total/25)),rows:result.rows});}catch(error){next(error)}}

export async function reset(req,res){
  const type=typeOf(req),userId=id(req.params.id);
  try{if(!userId)throw new Error("User not found.");const hash=await bcrypt.hash("College1",10);const table=type==="staff"?"staff":"public_users";const roleClause=type==="staff"?"":" AND role=?";const params=type==="staff"?[hash,userId]:[hash,userId,type];const [result]=await pool.query(`UPDATE ${table} SET password_hash=? WHERE id=?${roleClause} LIMIT 1`,params);if(!result.affectedRows)throw new Error("User not found.");await writeAudit(null,req,{action:"PASSWORD_RESET_TO_DEFAULT",entityType:type,entityId:userId,newValues:{reset:true}});req.flash("success","Password has been reset to College1.");}catch(error){req.flash("error",error.message||"Password could not be reset.");}res.redirect(req.get("referer")||`/staff/password/${type}`);
}

export async function detailsPage(req,res,next){
  try{const type=typeOf(req),q=clean(req.query.q).slice(0,100),page=Math.max(1,id(req.query.page)||1),editId=id(req.query.edit),result=await users(type,q,page);let editing=null;if(editId){if(type==="staff")[[editing]]=await pool.query(`SELECT id,staff_no,full_name,first_name,middle_name,last_name,username,email,phone,status,school_id,department_id FROM staff WHERE id=?`,[editId]);else [[editing]]=await pool.query(`SELECT id,role,first_name,middle_name,last_name,dob,gender,state_of_origin,lga,phone,address,username email,matric_number,status FROM public_users WHERE id=? AND role=?`,[editId,type]);}res.render("pages/staff/edit-user-details",{layout:"layouts/adminlte",title:"Edit User Details",pageTitle:"Edit User Details",type,q,page,totalPages:Math.max(1,Math.ceil(result.total/25)),rows:result.rows,editing});
  }catch(error){next(error)}
}

export async function updateDetails(req,res){
  const type=typeOf(req),userId=id(req.params.id),connection=await pool.getConnection();
  try{await connection.beginTransaction();const first=clean(req.body.first_name),last=clean(req.body.last_name),middle=clean(req.body.middle_name),email=clean(req.body.email).toLowerCase();if(!first||!last||!email)throw new Error("First name, surname and email are required.");if(type==="staff"){const [[before]]=await connection.query(`SELECT * FROM staff WHERE id=? FOR UPDATE`,[userId]);if(!before)throw new Error("Staff record not found.");await connection.query(`UPDATE staff SET first_name=?,middle_name=?,last_name=?,full_name=?,email=?,username=?,phone=?,status=? WHERE id=?`,[first,middle||null,last,[first,middle,last].filter(Boolean).join(' '),email,email,clean(req.body.phone)||null,clean(req.body.status)==="INACTIVE"?"INACTIVE":"ACTIVE",userId]);await writeAudit(connection,req,{action:"STAFF_BIODATA_UPDATED",entityType:"staff",entityId:userId,oldValues:{email:before.email,phone:before.phone},newValues:{email,phone:req.body.phone}});}else{const [[before]]=await connection.query(`SELECT * FROM public_users WHERE id=? AND role=? FOR UPDATE`,[userId,type]);if(!before)throw new Error("Portal user not found.");const [[duplicate]]=await connection.query(`SELECT id FROM public_users WHERE username=? AND id<>? LIMIT 1`,[email,userId]);if(duplicate)throw new Error("That email belongs to another portal account.");await connection.query(`UPDATE public_users SET first_name=?,middle_name=?,last_name=?,username=?,phone=?,dob=?,gender=?,state_of_origin=?,lga=?,address=?,status=? WHERE id=? AND role=?`,[first,middle||null,last,email,clean(req.body.phone)||null,clean(req.body.dob)||null,clean(req.body.gender)||null,clean(req.body.state_of_origin)||null,clean(req.body.lga)||null,clean(req.body.address)||null,clean(req.body.status)==="INACTIVE"?"INACTIVE":"ACTIVE",userId,type]);await writeAudit(connection,req,{action:"PORTAL_BIODATA_UPDATED",entityType:type,entityId:userId,oldValues:{email:before.username,phone:before.phone},newValues:{email,phone:req.body.phone}});}await connection.commit();req.flash("success","Biodata updated successfully.");}catch(error){await connection.rollback();req.flash("error",error.message||"Biodata could not be updated.");}finally{connection.release()}res.redirect(`/staff/password/edit-details?type=${type}&edit=${userId}`);
}

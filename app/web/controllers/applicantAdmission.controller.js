import crypto from "crypto";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from 'path';
import fs from 'fs/promises';
import { PDFDocument as PDFLibDocument, StandardFonts, rgb } from 'pdf-lib';
import { pool } from "../../core/db.js";

const secret = () => process.env.DOCUMENT_QR_SECRET || process.env.SESSION_SECRET || "change-this-document-secret";
const tokenFor = documentNumber => crypto.createHmac("sha256", secret()).update(documentNumber).digest("hex");
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");

async function ownedAdmission(applicationId, userId) {
  const [rows] = await pool.query(
    `SELECT aa.*,af.title application_title,af.session_id,s.name session_name,
      pu.first_name,pu.middle_name,pu.last_name,pu.username email,
      ad.id decision_id,ad.status decision_status,ad.offered_programme_name,ad.admitted_at,ad.revoked_at,
      sc.name school_name,d.name department_name,p.name programme_name,
      COALESCE(ast.acceptance_required_for_letter,1) acceptance_required_for_letter,
      ast.registrar_name,ast.registrar_position,ast.registrar_signature_path,
      (SELECT storage_path FROM application_documents ax WHERE ax.applicant_application_id=aa.id AND ax.document_type='PASSPORT' AND ax.is_current=1 AND ax.deleted_at IS NULL ORDER BY ax.id DESC LIMIT 1) passport_path
      FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id
      JOIN sessions s ON s.id=af.session_id JOIN public_users pu ON pu.id=aa.applicant_user_id
      LEFT JOIN admission_decisions ad ON ad.applicant_application_id=aa.id
      LEFT JOIN schools sc ON sc.id=ad.offered_school_id LEFT JOIN departments d ON d.id=ad.offered_department_id
      LEFT JOIN programmes p ON p.id=ad.offered_programme_id
      LEFT JOIN admission_settings ast ON ast.session_id=af.session_id AND (ast.application_form_id=af.id OR ast.application_form_id IS NULL)
      WHERE aa.id=? AND aa.applicant_user_id=? ORDER BY ast.application_form_id DESC LIMIT 1`,
    [applicationId,userId],
  );
  return rows[0] || null;
}

export async function statusPage(req,res,next) {
  try {
    const userId=Number(req.session?.publicUser?.id||0);
    const [applications]=await pool.query(
      `SELECT aa.id,aa.application_number,aa.status,aa.acceptance_payment_status,aa.submitted_at,
       af.title application_title,s.name session_name,ad.status decision_status,ad.offered_programme_name,ad.admitted_at,ad.revoked_at,
       COALESCE(ast.acceptance_required_for_letter,1) acceptance_required_for_letter,
       EXISTS(SELECT 1 FROM admission_document_templates adt WHERE adt.document_type='ADMISSION_LETTER' AND adt.status='PUBLISHED' AND (adt.session_id IS NULL OR adt.session_id=af.session_id) AND (adt.application_form_id IS NULL OR adt.application_form_id=af.id)) has_published_letter_template,
       EXISTS(SELECT 1 FROM admission_document_templates adt WHERE adt.document_type='ADMISSION_NOTIFICATION' AND adt.status='PUBLISHED' AND (adt.session_id IS NULL OR adt.session_id=af.session_id) AND (adt.application_form_id IS NULL OR adt.application_form_id=af.id)) has_published_notification_template
       FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN sessions s ON s.id=af.session_id
       LEFT JOIN admission_decisions ad ON ad.applicant_application_id=aa.id
       LEFT JOIN admission_settings ast ON ast.session_id=af.session_id AND (ast.application_form_id=af.id OR ast.application_form_id IS NULL)
       WHERE aa.applicant_user_id=? ORDER BY aa.id DESC,ast.application_form_id DESC`,[userId]);
    res.render("applications/applicant-admission-status",{layout:"layouts/adminlte",title:"Admission Status",pageTitle:"Admission Status",applications});
  }catch(error){next(error);}
}

export async function notificationsPage(req,res,next){
  try{
    const userId=Number(req.session?.publicUser?.id||0);
    const [notifications]=await pool.query(`SELECT * FROM portal_notifications WHERE public_user_id=? ORDER BY created_at DESC LIMIT 100`,[userId]);
    await pool.query(`UPDATE portal_notifications SET read_at=COALESCE(read_at,NOW()) WHERE public_user_id=?`,[userId]);
    res.render("applications/applicant-notifications",{layout:"layouts/adminlte",title:"Notifications",pageTitle:"Notifications",notifications});
  }catch(error){next(error);}
}

export async function announcementsPage(req,res,next){
  try{const userId=Number(req.session?.publicUser?.id||0);const [announcements]=await pool.query(`SELECT pa.*,ar.read_at FROM portal_announcements pa LEFT JOIN announcement_reads ar ON ar.announcement_id=pa.id AND ar.public_user_id=? WHERE pa.status='PUBLISHED' AND pa.audience_role IN ('applicant','both') AND pa.publish_at<=NOW() AND (pa.expires_at IS NULL OR pa.expires_at>NOW()) AND EXISTS(SELECT 1 FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id WHERE aa.applicant_user_id=? AND aa.submitted_at IS NOT NULL AND (pa.session_id IS NULL OR pa.session_id=af.session_id) AND (pa.application_form_id IS NULL OR pa.application_form_id=aa.application_form_id) AND (pa.admission_status IS NULL OR pa.admission_status=aa.status) AND (pa.school_id IS NULL OR pa.school_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.school_id')) AS UNSIGNED)) AND (pa.department_id IS NULL OR pa.department_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.department_id')) AS UNSIGNED)) AND (pa.programme_id IS NULL OR pa.programme_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.programme_id')) AS UNSIGNED))) ORDER BY FIELD(pa.priority,'URGENT','IMPORTANT','NORMAL'),pa.publish_at DESC`,[userId,userId]);if(announcements.length)await pool.query(`INSERT IGNORE INTO announcement_reads (announcement_id,public_user_id) VALUES ?`,[announcements.map(x=>[x.id,userId])]);res.render('applications/applicant-announcements',{layout:'layouts/adminlte',title:'Announcements',pageTitle:'Announcements',announcements});}catch(error){next(error)}
}

async function issuedDocument(application,templateId=null,documentType='ADMISSION_LETTER'){
  const [[existing]]=await pool.query(`SELECT * FROM issued_admission_documents WHERE applicant_application_id=? AND document_type=? AND status='VALID' ORDER BY id DESC LIMIT 1`,[application.id,documentType]);
  if(existing)return existing;
  const prefix=documentType==='ADMISSION_NOTIFICATION'?'ADN':'ADM';const number=`${prefix}-${application.session_id}-${String(application.id).padStart(7,"0")}`;
  const token=tokenFor(number);
  const [result]=await pool.query(
    `INSERT INTO issued_admission_documents (applicant_application_id,admission_decision_id,template_id,document_type,document_number,verification_token_hash)
     VALUES (?,?,?,?,?,?)`,[application.id,application.decision_id,templateId,documentType,number,tokenHash(token)]);
  return {id:result.insertId,document_number:number,template_id:templateId,status:"VALID",issued_at:new Date()};
}

async function publishedTemplate(type,application){
  const [rows]=await pool.query(`SELECT * FROM admission_document_templates WHERE document_type=? AND status='PUBLISHED' AND (session_id IS NULL OR session_id=?) AND (application_form_id IS NULL OR application_form_id=?) ORDER BY (application_form_id IS NOT NULL) DESC,(session_id IS NOT NULL) DESC,version_no DESC LIMIT 1`,[type,application.session_id,application.application_form_id]);
  return rows[0]||null;
}
function templateText(value,replacements){
  let text=String(value||"");for(const [key,replacement] of Object.entries(replacements))text=text.replaceAll(`{{${key}}}`,String(replacement||""));
  return text.replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/p>/gi,"\n\n").replace(/<\/(?:div|h[1-6]|li|tr)>/gi,"\n").replace(/<li[^>]*>/gi,"• ").replace(/<[^>]+>/g,"").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/\n{3,}/g,"\n\n").trim();
}
function templateHtml(value,replacements){let html=String(value||'').replace(/\{\{\s*programme_name\s*\)/gi,'{{programme_name}}');for(const [key,replacement] of Object.entries(replacements))html=html.replaceAll(`{{${key}}}`,String(replacement||''));return html}
function decodeHtml(value){return String(value||'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&#8358;|&#x20a6;/gi,'₦')}
function hasWholeParagraphStyle(value,styleTags){
  let html=String(value||'').trim();const neutral=styleTags.includes('b')?new Set(['font','span','i','em']):new Set(['font','span','b','strong']);
  while(true){const outer=html.match(/^<([a-z][a-z0-9]*)\b[^>]*>([\s\S]*)<\/\1>$/i);if(!outer||!neutral.has(outer[1].toLowerCase()))break;html=outer[2].trim()}
  const tags=styleTags.join('|');return new RegExp(`^<(?:${tags})(?:\\s[^>]*)?>[\\s\\S]*<\\/(?:${tags})>$`,'i').test(html)
}
function renderTemplateBody(doc,html,{x=55,y=180,width=485}={}){
  const source=String(html||'').replace(/<br\s*\/?\s*>/gi,'\n');
  const blocks=[];const blockPattern=/<(p|div|h[1-6]|li)([^>]*)>([\s\S]*?)<\/\1>/gi;let match;
  while((match=blockPattern.exec(source)))blocks.push({tag:match[1].toLowerCase(),attrs:match[2],inner:match[3]});
  if(!blocks.length)blocks.push({tag:'p',attrs:'',inner:source});
  doc.x=x;doc.y=y;
  for(const block of blocks){
    const style=`${block.attrs} ${block.inner.match(/<(?:span|font)[^>]*style=["'][^"']*["'][^>]*>/i)?.[0]||''}`;
    const explicitAlign=style.match(/text-align\s*:\s*(left|right|center|justify)/i)?.[1];
    const rawText=block.inner.replace(/<[^>]+>/g,'');const leadingSpaces=(rawText.match(/^(?:\s|&nbsp;)+/i)?.[0].match(/&nbsp;/gi)||[]).length;
    const htmlSize=Number(block.inner.match(/<font[^>]*size=["']?(\d+)/i)?.[1]||0);
    const cssSizeMatch=style.match(/font-size\s*:\s*([\d.]+)(px|pt)/i);const cssSize=Number(cssSizeMatch?.[1]||0);const cssPoints=cssSizeMatch?.[2]?.toLowerCase()==='px'?cssSize*.75:cssSize;
    const size=block.tag.startsWith('h')?Math.max(13,18-Number(block.tag.slice(1))):cssSize?Math.max(8,Math.min(18,cssPoints)):({1:8,2:10,3:11,4:13,5:16,6:20,7:24}[htmlSize]||11);
    const isBold=hasWholeParagraphStyle(block.inner,['b','strong'])||block.tag.startsWith('h');
    const isItalic=hasWholeParagraphStyle(block.inner,['i','em']);
    const align=(explicitAlign||(leadingSpaces>=10?'right':isBold?'left':'justify')).toLowerCase();
    const isTimes=/Times New Roman/i.test(style);const font=isTimes?(isBold&&isItalic?'Times-BoldItalic':isBold?'Times-Bold':isItalic?'Times-Italic':'Times-Roman'):(isBold&&isItalic?'Helvetica-BoldOblique':isBold?'Helvetica-Bold':isItalic?'Helvetica-Oblique':'Helvetica');
    const colour=style.match(/(?:color|font-color)\s*:\s*(#[0-9a-f]{3,6}|[a-z]+)/i)?.[1]||'#222';
    const prefix=block.tag==='li'?'• ':'';
    const text=prefix+decodeHtml(block.inner.replace(/<[^>]+>/g,'')).replace(/\s+/g,' ').trim();
    if(!text)continue;
    doc.font(font).fontSize(size).fillColor(colour).text(text,{width,align,lineGap:4});
    doc.moveDown(.55);
  }
}
function drawTiledWatermark(doc,imagePath,opacity=.1){const xs=[65,250,435],ys=[180,390,600];for(const y of ys)for(const x of xs){try{doc.save().opacity(opacity).image(imagePath,x,y,{fit:[95,105],align:'center',valign:'center'}).restore().opacity(1)}catch{}}}
function drawPersonalWatermark(doc,text){for(const y of [230,390,550,710])doc.save().opacity(.11).fillColor('#d71920').font('Helvetica-Bold').fontSize(18).rotate(-24,{origin:[300,y]}).text(text,45,y,{width:520,align:'center'}).restore().opacity(1)}
function printedAt(){return new Date().toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'})}
function drawPrintDetails(doc,qr){doc.font('Helvetica').fontSize(7).fillColor('#555').text(`Printed: ${printedAt()}`,390,18,{width:150,align:'right',lineBreak:false});doc.image(qr,485,700,{width:52});doc.fontSize(6).text('Verification Code',470,754,{width:82,align:'center',lineBreak:false});}
function drawContinuationPage(doc,{template,personalText,qr,margin=55}){
  if(template?.watermark_text)doc.save().font('Helvetica-Bold').fontSize(52).fillColor('#777').opacity(Number(template.watermark_opacity)||.1).rotate(-35,{origin:[300,430]}).text(template.watermark_text,80,360,{width:500,align:'center'}).restore().opacity(1);
  if(template?.watermark_image_path)drawTiledWatermark(doc,path.resolve('app/web'+template.watermark_image_path),Number(template.watermark_opacity)||.1);
  drawPersonalWatermark(doc,personalText);drawPrintDetails(doc,qr);doc.x=margin;doc.y=55;
}

async function appendTemplateAttachment(mainBuffer,attachmentPath,qrBuffer){if(!attachmentPath)return mainBuffer;try{const resolved=attachmentPath.startsWith('/public/')?path.resolve('app/web'+attachmentPath):path.resolve(attachmentPath);const allowedInternal=path.resolve('app/uploads/admission-template-attachments')+path.sep,allowedPublic=path.resolve('app/web/public/uploads/admission-templates')+path.sep;if(!resolved.startsWith(allowedInternal)&&!resolved.startsWith(allowedPublic))throw new Error('Attachment path is not permitted.');const attachment=await fs.readFile(resolved);const output=await PDFLibDocument.load(mainBuffer);const extra=await PDFLibDocument.load(attachment);const pages=await output.copyPages(extra,extra.getPageIndices());const font=await output.embedFont(StandardFonts.Helvetica),qr=await output.embedPng(qrBuffer),stamp=printedAt();pages.forEach(page=>{const {width,height}=page.getSize();page.drawText(`Printed: ${stamp}`,{x:width-175,y:height-18,size:7,font,color:rgb(.33,.33,.33)});page.drawImage(qr,{x:width-70,y:25,width:45,height:45});page.drawText('Verification Code',{x:width-82,y:15,size:5.5,font,color:rgb(.33,.33,.33)});output.addPage(page)});return Buffer.from(await output.save())}catch(error){console.error('Admission attachment merge failed:',error.message);return mainBuffer}}

async function admissionPdf(req,res,next,documentType){
  try{
    const application=await ownedAdmission(Number(req.params.applicationId),Number(req.session?.publicUser?.id||0));
    if(!application||application.decision_status!=="ADMITTED")return res.status(404).send("An active admission offer was not found.");
    const isLetter=documentType==='ADMISSION_LETTER';const documentLabel=isLetter?'Admission Letter':'Admission Notification';
    if(isLetter&&Number(application.acceptance_required_for_letter)===1&&application.acceptance_payment_status!=="PAID")return res.status(403).render("pages/denied",{layout:"layouts/adminlte",title:"Admission Letter Unavailable",pageTitle:"Admission Letter Unavailable",reason:"Payment of the acceptance fee is required before your admission letter can be printed.",homeHref:"/applicant/admission/status"});
    const resolvedTemplate=await publishedTemplate(documentType,application);
    if(!resolvedTemplate)return res.status(409).render("pages/denied",{layout:"layouts/adminlte",title:`${documentLabel} Not Yet Available`,pageTitle:`${documentLabel} Not Yet Available`,reason:`Your ${documentLabel.toLowerCase()} has not yet been published. Please contact the Registry for assistance.`,homeHref:"/applicant/admission/status"});
    const issued=await issuedDocument(application,resolvedTemplate.id,documentType);
    const token=tokenFor(issued.document_number);
    const base=String(process.env.PORTAL_BASE_URL||`${req.protocol}://${req.get("host")}`).replace(/\/$/,"");
    const verifyUrl=`${base}/verify/admission-document/${token}`;
    const qr=await QRCode.toBuffer(verifyUrl,{width:180,margin:1,errorCorrectionLevel:"M"});
    const fullName=[application.first_name,application.middle_name,application.last_name].filter(Boolean).join(" ").toUpperCase();
    const programme=application.programme_name||application.offered_programme_name||application.programme_choice||"the approved programme";
    const [[issuedTemplate]]=issued.template_id?await pool.query(`SELECT * FROM admission_document_templates WHERE id=?`,[issued.template_id]):[[]];
    const template=issuedTemplate||resolvedTemplate;
    const replacements={applicant_name:fullName,application_number:application.application_number,programme_name:programme,department_name:application.department_name||"",school_name:application.school_name||"",session_name:application.session_name,current_date:new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}),admission_date:new Date(application.admitted_at).toLocaleDateString("en-GB")};
    const letterTitle=templateText(template.title,replacements);
    const letterTitle2=templateText(template.title_line_2,replacements);
    const letterBody=templateHtml(template.body_html,replacements);
    const doc=new PDFDocument({size:"A4",margin:55,bufferPages:true,info:{Title:documentLabel,Author:"EKSCOTECH"}});const chunks=[];doc.on('data',chunk=>chunks.push(chunk));const completed=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename="${isLetter?'admission-letter':'admission-notification'}-${application.application_number}.pdf"`);
    const personalText=`${fullName} • ${programme} • ${application.session_name} • ${documentType.replaceAll('_',' ')}`;
    doc.on('pageAdded',()=>drawContinuationPage(doc,{template,personalText,qr}));
    if(template?.watermark_text){doc.save().font('Helvetica-Bold').fontSize(52).fillColor('#777').opacity(Number(template.watermark_opacity)||.1).rotate(-35,{origin:[300,430]}).text(template.watermark_text,80,360,{width:500,align:'center'}).restore().opacity(1)}
    if(template?.watermark_image_path)drawTiledWatermark(doc,path.resolve('app/web'+template.watermark_image_path),Number(template.watermark_opacity)||.1);
    drawPersonalWatermark(doc,personalText);
    try{doc.image("app/web/public/img/logo.png",60,42,{width:58});}catch{}
    if(application.passport_path){try{doc.image(path.resolve(application.passport_path),482,42,{fit:[58,70],align:'center',valign:'center'});}catch{}}
    drawPrintDetails(doc,qr);
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#247D57").text("EKITI STATE COLLEGE OF TECHNOLOGY",125,48,{align:"center",width:345});
    doc.fontSize(10).fillColor("#333").text("IJERO-EKITI, EKITI STATE",125,70,{align:"center",width:345});
    doc.fontSize(8).text("P.M.B. 316, Epe Ara Road, Ijero-Ekiti, Ekiti State",125,86,{align:"center",width:345});
    doc.moveTo(55,120).lineTo(540,120).strokeColor("#82103C").lineWidth(2).stroke();
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#82103C").text(letterTitle,55,140,{align:"center"});
    if(letterTitle2)doc.font("Helvetica-Bold").fontSize(15).text(letterTitle2,55,164,{align:'center'});
    const bodyY=letterTitle2?200:180;
    renderTemplateBody(doc,letterBody,{x:55,y:bodyY,width:485});
    const signatoryName=template.registrar_name||application.registrar_name||'Registrar';const signatoryPosition=template.registrar_position||application.registrar_position||'Registrar';const signaturePath=template.registrar_signature_path||application.registrar_signature_path;
    let signatureY=doc.y+6;if(signatureY>680){doc.addPage();signatureY=100}if(signaturePath){try{doc.image(path.resolve('app/web'+signaturePath),65,signatureY,{fit:[145,58],align:'left'})}catch{}}signatureY+=62;
    doc.font("Helvetica-Bold").fontSize(10).fillColor('#222').text(signatoryName,65,signatureY,{width:210}).font("Helvetica").fontSize(9).text(signatoryPosition,65,signatureY+16,{width:210}).text("For: Ekiti State College of Technology",65,signatureY+30,{width:250});
    doc.end();const mainBuffer=await completed;const output=await appendTemplateAttachment(mainBuffer,template.attachment_path,qr);return res.send(output);
  }catch(error){next(error);}
}
export const admissionLetter=(req,res,next)=>admissionPdf(req,res,next,'ADMISSION_LETTER');
export const admissionNotification=(req,res,next)=>admissionPdf(req,res,next,'ADMISSION_NOTIFICATION');

export async function verifyDocument(req,res,next){
  try{
    const hash=tokenHash(String(req.params.token||""));
    const [rows]=await pool.query(
      `SELECT iad.document_number,iad.document_type,iad.status,iad.issued_at,
       aa.application_number,af.title application_type,s.name session_name,ad.offered_programme_name,
       pu.first_name,pu.middle_name,pu.last_name,sc.name school_name,d.name department_name,p.name programme_name
       FROM issued_admission_documents iad JOIN applicant_applications aa ON aa.id=iad.applicant_application_id
       JOIN application_forms af ON af.id=aa.application_form_id JOIN sessions s ON s.id=af.session_id
       JOIN public_users pu ON pu.id=aa.applicant_user_id LEFT JOIN admission_decisions ad ON ad.id=iad.admission_decision_id
       LEFT JOIN schools sc ON sc.id=COALESCE(ad.offered_school_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.school_id')) AS UNSIGNED))
       LEFT JOIN departments d ON d.id=COALESCE(ad.offered_department_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.department_id')) AS UNSIGNED))
       LEFT JOIN programmes p ON p.id=COALESCE(ad.offered_programme_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.programme_id')) AS UNSIGNED))
       WHERE iad.verification_token_hash=? LIMIT 1`,[hash]);
    res.render("pages/document-verification",{layout:false,title:"Document Verification",document:rows[0]||null,isSample:false});
  }catch(error){next(error);}
}

export function sampleDocumentVerification(_req,res){return res.render('pages/document-verification',{layout:false,title:'Sample Verification',isSample:true,document:{status:'SAMPLE',document_number:'SAMPLE-DOCUMENT',document_type:'ADMISSION_LETTER',first_name:'ADEBAYO',middle_name:'GRACE',last_name:'OLUWATOBI',application_number:'APP-2026-SAMPLE-001',application_type:'Sample application',session_name:'2026/2027',school_name:'School of Allied Health Sciences',department_name:'Community Health Sciences',programme_name:'Community Health',issued_at:new Date()}})}

function applicationScope(formData){
  let data={}; try{data=typeof formData==='object'?formData:JSON.parse(formData||"{}");}catch{}
  const choice=data?.application_details?.programme_choice||{};
  return {schoolId:Number(choice.school_id||data.school_id||0)||null,departmentId:Number(choice.department_id||data.department_id||0)||null,programmeId:Number(choice.programme_id||data.programme_id||0)||null};
}

async function resolveScreening(application){
  const scope=applicationScope(application.form_data);
  const [rows]=await pool.query(
    `SELECT * FROM screening_schedules WHERE session_id=? AND status='PUBLISHED'
      AND (application_form_id IS NULL OR application_form_id=?)
      AND (school_id IS NULL OR school_id=?) AND (department_id IS NULL OR department_id=?)
      AND (programme_id IS NULL OR programme_id=?) AND (applicant_application_id IS NULL OR applicant_application_id=?)
      ORDER BY (applicant_application_id IS NOT NULL) DESC,(programme_id IS NOT NULL) DESC,
      (department_id IS NOT NULL) DESC,(school_id IS NOT NULL) DESC,(application_form_id IS NOT NULL) DESC,id DESC LIMIT 1`,
    [application.session_id,application.application_form_id,scope.schoolId,scope.departmentId,scope.programmeId,application.id]);
  return rows[0]||null;
}

export async function screeningPage(req,res,next){
  try{
    const userId=Number(req.session?.publicUser?.id||0);
    const [applications]=await pool.query(`SELECT aa.*,af.title application_title,af.session_id,s.name session_name FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN sessions s ON s.id=af.session_id WHERE aa.applicant_user_id=? AND aa.submitted_at IS NOT NULL ORDER BY aa.id DESC`,[userId]);
    for(const application of applications){application.screening=await resolveScreening(application);application.has_published_slip_template=Boolean(await publishedTemplate('SCREENING_SLIP',application));}
    res.render("applications/applicant-screening",{layout:"layouts/adminlte",title:"Screening Schedule",pageTitle:"Screening Schedule",applications});
  }catch(error){next(error);}
}

export async function screeningSlip(req,res,next){
  try{
    const application=await ownedAdmission(Number(req.params.applicationId),Number(req.session?.publicUser?.id||0)) || (await pool.query(`SELECT aa.*,af.title application_title,af.session_id,s.name session_name,pu.first_name,pu.middle_name,pu.last_name FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN sessions s ON s.id=af.session_id JOIN public_users pu ON pu.id=aa.applicant_user_id WHERE aa.id=? AND aa.applicant_user_id=?`,[Number(req.params.applicationId),Number(req.session?.publicUser?.id||0)]))[0][0];
    if(!application)return res.status(404).send("Application not found.");
    const schedule=await resolveScreening(application); if(!schedule)return res.status(404).send("A published screening schedule was not found.");
    const template=await publishedTemplate('SCREENING_SLIP',application);
    if(!template)return res.status(409).render("pages/denied",{layout:"layouts/adminlte",title:"Screening Slip Not Yet Available",pageTitle:"Screening Slip Not Yet Available",reason:"Your screening slip template has not yet been published. Please contact the Registry for assistance.",homeHref:"/applicant/screening"});
    const [[existing]]=await pool.query(`SELECT * FROM issued_admission_documents WHERE applicant_application_id=? AND screening_assignment_id=? AND document_type='SCREENING_SLIP' AND status='VALID' LIMIT 1`,[application.id,schedule.id]);
    let issued=existing;
    if(!issued){const number=`SCR-${application.session_id}-${schedule.id}-${String(application.id).padStart(7,"0")}`;const token=tokenFor(number);const [r]=await pool.query(`INSERT INTO issued_admission_documents (applicant_application_id,screening_assignment_id,document_type,document_number,verification_token_hash) VALUES (?,?,'SCREENING_SLIP',?,?)`,[application.id,schedule.id,number,tokenHash(token)]);issued={id:r.insertId,document_number:number};}
    const token=tokenFor(issued.document_number),base=String(process.env.PORTAL_BASE_URL||`${req.protocol}://${req.get("host")}`).replace(/\/$/,""),verifyUrl=`${base}/verify/admission-document/${token}`;
    const qr=await QRCode.toBuffer(verifyUrl,{width:180,margin:1}); const doc=new PDFDocument({size:"A4",margin:50});
    res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`inline; filename="screening-slip-${application.application_number}.pdf"`);doc.pipe(res);
    if(template?.watermark_text){doc.save().font('Helvetica-Bold').fontSize(52).fillColor('#777').opacity(Number(template.watermark_opacity)||.1).rotate(-35,{origin:[300,430]}).text(template.watermark_text,80,360,{width:500,align:'center'}).restore().opacity(1)}
    if(template?.watermark_image_path)drawTiledWatermark(doc,path.resolve('app/web'+template.watermark_image_path),Number(template.watermark_opacity)||.1);
    const screeningName=[application.first_name,application.middle_name,application.last_name].filter(Boolean).join(' ').toUpperCase();const screeningProgramme=application.programme_name||application.offered_programme_name||application.programme_choice||application.application_title;
    const personalText=`${screeningName} • ${screeningProgramme} • ${application.session_name} • SCREENING SLIP`;
    doc.on('pageAdded',()=>drawContinuationPage(doc,{template,personalText,qr,margin:50}));drawPersonalWatermark(doc,personalText);
    try{doc.image("app/web/public/img/logo.png",55,35,{width:70});}catch{}
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#247D57").text("EKITI STATE COLLEGE OF TECHNOLOGY",125,40,{width:345,align:"center"}).fontSize(10).fillColor("#333").text("IJERO-EKITI, EKITI STATE",125,62,{width:345,align:"center"}).fontSize(8).text("P.M.B. 316, Epe Ara Road, Ijero-Ekiti, Ekiti State",125,78,{width:345,align:"center"}).fontSize(13).fillColor("#82103C").text("APPLICANT SCREENING SLIP",125,96,{width:345,align:"center"});
    doc.image(qr,485,35,{width:58});doc.fontSize(6.5).fillColor('#555').text("Verification Code",470,95,{width:88,align:"center"});
    doc.moveTo(50,120).lineTo(545,120).strokeColor("#82103C").stroke(); const name=[application.first_name,application.middle_name,application.last_name].filter(Boolean).join(" ");
    let y=150; const row=(label,value)=>{doc.font("Helvetica-Bold").fillColor("#222").fontSize(10).text(label,65,y,{width:150});doc.font("Helvetica").text(String(value||"—"),220,y,{width:300});y+=30;};
    row("Applicant",name);row("Application Number",application.application_number);row("Application Type",application.application_title);row("Academic Session",application.session_name);row("Screening Type",schedule.screening_type);row("Screening Date",new Date(schedule.screening_date).toLocaleDateString("en-GB",{weekday:"long",day:"2-digit",month:"long",year:"numeric"}));row("Reporting Time",schedule.reporting_time||"As communicated");row("Start Time",schedule.start_time||"As communicated");row("Venue",schedule.venue);row("Batch",schedule.batch_name||"—");
    if(schedule.instructions){doc.moveDown().font("Helvetica-Bold").text("Instructions").font("Helvetica").text(schedule.instructions,{lineGap:3});}
    doc.fontSize(8).text(`Document No: ${issued.document_number}`,50,770);doc.end();
  }catch(error){next(error);}
}

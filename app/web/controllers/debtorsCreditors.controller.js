import { pool } from "../../core/db.js";
import XLSX from "xlsx";
import PDFDocument from "pdfkit";
import path from "path";

const num = value => Number.parseInt(value,10)||0;
const clean = value => String(value??"").trim();
const levelToken=value=>clean(value).replace(/\s+/g,"").replace(/LEVEL/gi,"").toUpperCase();
const levelAliases=value=>{
  const token=levelToken(value);const aliases=new Set(token?[token]:[]);
  const pairs={100:["ND1"],200:["ND2"],300:["ND3","HND1"],400:["HND2"],500:["HND3"],ND1:["100"],ND2:["200"],ND3:["300"],HND1:["300"],HND2:["400"],HND3:["500"]};
  (pairs[token]||[]).forEach(x=>aliases.add(x));return [...aliases];
};

export async function reportData(req){
  const [[current]]=await pool.query(`SELECT id,name FROM sessions WHERE is_current=1 ORDER BY id DESC LIMIT 1`);
  const category=['SCHOOL_FEE','ACCEPTANCE','COMPULSORY'].includes(clean(req.query.fee_category).toUpperCase())?clean(req.query.fee_category).toUpperCase():'SCHOOL_FEE';
  const filters={sessionId:num(req.query.session_id)||num(current?.id),feeCategory:category,schoolId:num(req.query.school_id),departmentId:num(req.query.department_id),programmeId:num(req.query.programme_id),q:clean(req.query.q).slice(0,120)};
  const [feeTypes]=await pool.query(`SELECT pt.id,pt.name,pt.purpose,pt.amount,pt.scope,pt.uses_indigene_regime,pt.amount_indigene,pt.amount_non_indigene FROM payment_types pt WHERE pt.is_active=1 AND LOWER(CONCAT_WS(' ',pt.name,pt.purpose)) REGEXP 'school fee|school fees|tuition' AND (NOT EXISTS(SELECT 1 FROM payment_type_sessions x WHERE x.payment_type_id=pt.id) OR EXISTS(SELECT 1 FROM payment_type_sessions x WHERE x.payment_type_id=pt.id AND x.session_id=?)) ORDER BY pt.name`,[filters.sessionId]);
  const [[sessions],[schools],[departments],[programmes]]=await Promise.all([pool.query(`SELECT id,name,is_current FROM sessions ORDER BY id DESC`),pool.query(`SELECT id,name FROM schools ORDER BY name`),pool.query(`SELECT id,school_id,name FROM departments ORDER BY name`),pool.query(`SELECT id,school_id,department_id,name FROM programmes ORDER BY name`)]);
  let people=[];
  if(category==='SCHOOL_FEE'){
    const params=[];const where=[`(pu.role='student' OR EXISTS(SELECT 1 FROM portal_user_roles pur WHERE pur.public_user_id=pu.id AND pur.role='student'))`];
    if(filters.q){where.push(`(pu.matric_number LIKE ? OR pu.username LIKE ? OR CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) LIKE ?)`);const t=`%${filters.q}%`;params.push(t,t,t)}
    [people]=await pool.query(`SELECT pu.id,pu.matric_number,pu.username email,pu.phone,pu.state_of_origin,CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) full_name,sp.level,sp.school_id,sp.department_id,sp.programme_id,sc.name school_name,d.name department_name,p.name programme_name FROM public_users pu LEFT JOIN student_profiles sp ON sp.user_id=pu.id LEFT JOIN schools sc ON sc.id=sp.school_id LEFT JOIN departments d ON d.id=sp.department_id LEFT JOIN programmes p ON p.id=sp.programme_id WHERE ${where.join(' AND ')} ORDER BY full_name`,params);
    const [imports]=await pool.query(`SELECT matric_number,student_email,year_of_entry,school,department,programme,student_level,level,state_of_origin FROM student_imports ORDER BY id DESC`);
    const byMatric=new Map(),byEmail=new Map();for(const row of imports){const matric=clean(row.matric_number).toLowerCase(),email=clean(row.student_email).toLowerCase();if(matric&&!byMatric.has(matric))byMatric.set(matric,row);if(email&&!byEmail.has(email))byEmail.set(email,row)}
    const normal=value=>clean(value).toLowerCase();
    people=people.map(person=>{const imported=byMatric.get(normal(person.matric_number))||byEmail.get(normal(person.email))||{};let schoolId=Number(person.school_id)||0;const school=schools.find(x=>Number(x.id)===schoolId)||schools.find(x=>normal(x.name)===normal(imported.school));schoolId=Number(school?.id)||0;let departmentId=Number(person.department_id)||0;const department=departments.find(x=>Number(x.id)===departmentId)||departments.find(x=>normal(x.name)===normal(imported.department)&&(!schoolId||Number(x.school_id)===schoolId));departmentId=Number(department?.id)||0;let programmeId=Number(person.programme_id)||0;const programme=programmes.find(x=>Number(x.id)===programmeId)||programmes.find(x=>normal(x.name)===normal(imported.programme)&&(!departmentId||Number(x.department_id)===departmentId));programmeId=Number(programme?.id)||0;const admissionSession=sessions.find(x=>clean(x.name).startsWith(clean(imported.year_of_entry)));return {...person,level:person.level||imported.student_level||imported.level,state_of_origin:person.state_of_origin||imported.state_of_origin,admission_session_id:Number(admissionSession?.id)||null,school_id:schoolId||null,department_id:departmentId||null,programme_id:programmeId||null,school_name:person.school_name||school?.name||imported.school||null,department_name:person.department_name||department?.name||imported.department||null,programme_name:person.programme_name||programme?.name||imported.programme||null}});
    const ids=feeTypes.map(x=>Number(x.id));let scopeRows=[],ruleRows=[],payments=[],legacyPayments=[];
    if(ids.length){
      [scopeRows]=await pool.query(`SELECT payment_type_id,'school' kind,school_id target FROM payment_type_schools WHERE payment_type_id IN (?) UNION ALL SELECT payment_type_id,'department',department_id FROM payment_type_departments WHERE payment_type_id IN (?) UNION ALL SELECT payment_type_id,'programme',programme_id FROM payment_type_programmes WHERE payment_type_id IN (?)`,[ids,ids,ids]);
      [ruleRows]=await pool.query(`SELECT payment_type_id,entry_level,current_level,admission_session_id,amount_override FROM payment_type_rules WHERE payment_type_id IN (?)`,[ids]);
      [payments]=await pool.query(`SELECT * FROM payment_invoices pi WHERE pi.status='PAID' AND pi.payment_type_id IN (?) AND (pi.session_id=? OR (pi.session_id IS NULL AND (SELECT COUNT(DISTINCT pts.session_id) FROM payment_type_sessions pts WHERE pts.payment_type_id=pi.payment_type_id)<=1))`,[ids,filters.sessionId]);
    }
    const selectedSessionName=clean(sessions.find(x=>Number(x.id)===filters.sessionId)?.name);
    if(selectedSessionName){
      [legacyPayments]=await pool.query(`SELECT pay_id,matric_id,amount_paid,ref_number,order_id FROM legacy_student_payments WHERE LOWER(TRIM(status))='successful' AND TRIM(academic_session)=? AND LOWER(TRIM(pay_type))='school fees'`,[selectedSessionName]);
    }
    const scopes=new Map(),rules=new Map();
    scopeRows.forEach(x=>{if(!scopes.has(Number(x.payment_type_id)))scopes.set(Number(x.payment_type_id),[]);scopes.get(Number(x.payment_type_id)).push(x)});
    ruleRows.forEach(x=>{if(!rules.has(Number(x.payment_type_id)))rules.set(Number(x.payment_type_id),[]);rules.get(Number(x.payment_type_id)).push(x)});
    const applicable=(type,person)=>{
      if(clean(type.scope).toUpperCase()==='GENERAL')return false;
      const assigned=scopes.get(Number(type.id))||[];
      if(assigned.some(x=>x.kind==='school')&&!assigned.some(x=>x.kind==='school'&&Number(x.target)===Number(person.school_id)))return false;
      if(assigned.some(x=>x.kind==='department')&&!assigned.some(x=>x.kind==='department'&&Number(x.target)===Number(person.department_id)))return false;
      if(assigned.some(x=>x.kind==='programme')&&!assigned.some(x=>x.kind==='programme'&&Number(x.target)===Number(person.programme_id)))return false;
      const configured=rules.get(Number(type.id))||[];if(!configured.length)return true;
      const aliases=levelAliases(person.level);return configured.some(rule=>{
        const entry=levelToken(rule.entry_level),currentLevel=levelToken(rule.current_level);
        return (!entry||aliases.includes(entry))&&(!currentLevel||aliases.includes(currentLevel))&&(!rule.admission_session_id||Number(rule.admission_session_id)===Number(person.admission_session_id));
      });
    };
    people=people.map(person=>{
      const obligations=feeTypes.filter(type=>applicable(type,person));
      const expected=obligations.reduce((sum,type)=>{const matched=(rules.get(Number(type.id))||[]).find(rule=>{const aliases=levelAliases(person.level);return (!levelToken(rule.entry_level)||aliases.includes(levelToken(rule.entry_level)))&&(!levelToken(rule.current_level)||aliases.includes(levelToken(rule.current_level)))&&(!rule.admission_session_id||Number(rule.admission_session_id)===Number(person.admission_session_id));});let amount=Number(type.amount||0);if(Number(type.uses_indigene_regime)){amount=clean(person.state_of_origin).toLowerCase()==='ekiti'?Number(type.amount_indigene||0):Number(type.amount_non_indigene||0)}return sum+Number(matched?.amount_override??amount)},0);
      const typeIds=new Set(obligations.map(x=>Number(x.id)));const keys=[String(person.id),clean(person.matric_number).toLowerCase(),clean(person.email).toLowerCase()];
      const matchedCurrent=payments.filter(x=>typeIds.has(Number(x.payment_type_id))&&(Number(x.created_by)===Number(person.id)||keys.includes(clean(x.payee_id).toLowerCase())||clean(x.payee_email).toLowerCase()===clean(person.email).toLowerCase()));
      const currentPaid=matchedCurrent.reduce((sum,x)=>sum+Number(x.amount||0),0);
      const currentReferences=new Set(matchedCurrent.flatMap(x=>[clean(x.rrr),clean(x.order_id)]).filter(Boolean));
      const legacyPaid=legacyPayments.filter(x=>clean(x.matric_id).toLowerCase()===clean(person.matric_number).toLowerCase()&&!currentReferences.has(clean(x.ref_number))&&!currentReferences.has(clean(x.order_id))).reduce((sum,x)=>sum+Number(x.amount_paid||0),0);
      return {...person,expected,paid:currentPaid+legacyPaid,current_paid:currentPaid,legacy_paid:legacyPaid};
    });
  }else{
    const stage=category;const invoiceField=stage==='ACCEPTANCE'?'acceptance_invoice_id':'compulsory_invoice_id';const eligibility=stage==='ACCEPTANCE'?`ad.status='ADMITTED'`:`ad.status='ADMITTED' AND aa.acceptance_payment_status='PAID'`;
    [people]=await pool.query(`SELECT pu.id,pu.matric_number,pu.username email,pu.phone,CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) full_name,NULL level,COALESCE(ad.offered_school_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.school_id')) AS UNSIGNED)) school_id,COALESCE(ad.offered_department_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.department_id')) AS UNSIGNED)) department_id,COALESCE(ad.offered_programme_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.programme_id')) AS UNSIGNED)) programme_id,COALESCE(sc.name,JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.school_name'))) school_name,COALESCE(d.name,JSON_UNQUOTE(JSON_EXTRACT(aa.form_data,'$.application_details.programme_choice.department_name'))) department_name,COALESCE(p.name,ad.offered_programme_name,aa.programme_choice) programme_name,COALESCE((SELECT SUM(c.amount) FROM application_form_charges c WHERE c.application_form_id=aa.application_form_id AND c.charge_stage=? AND c.is_active=1),0) expected,CASE WHEN inv.status='PAID' THEN inv.amount ELSE 0 END paid FROM applicant_applications aa JOIN application_forms af ON af.id=aa.application_form_id JOIN public_users pu ON pu.id=aa.applicant_user_id JOIN admission_decisions ad ON ad.applicant_application_id=aa.id LEFT JOIN payment_invoices inv ON inv.id=aa.${invoiceField} LEFT JOIN schools sc ON sc.id=ad.offered_school_id LEFT JOIN departments d ON d.id=ad.offered_department_id LEFT JOIN programmes p ON p.id=ad.offered_programme_id WHERE af.session_id=? AND ${eligibility} ORDER BY full_name`,[stage,filters.sessionId]);
  }
  let rows=people;if(filters.q&&category!=='SCHOOL_FEE'){const term=filters.q.toLowerCase();rows=rows.filter(x=>[x.full_name,x.matric_number,x.email].some(v=>clean(v).toLowerCase().includes(term)))}if(filters.schoolId)rows=rows.filter(x=>Number(x.school_id)===filters.schoolId);if(filters.departmentId)rows=rows.filter(x=>Number(x.department_id)===filters.departmentId);if(filters.programmeId)rows=rows.filter(x=>Number(x.programme_id)===filters.programmeId);
  rows=rows.map(x=>{const balance=Number(x.expected||0)-Number(x.paid||0);return {...x,balance,status:balance>0?'DEBTOR':balance<0?'CREDITOR':'CLEARED'}});
  const categoryLabel=category==='SCHOOL_FEE'?'School Fee':category==='ACCEPTANCE'?'Acceptance Fee':'Compulsory Fee';
  return {rows,filters,sessions,schools,departments,programmes,feeTypes,categoryLabel,obligationCount:rows.filter(x=>Number(x.expected)>0).length,sessionName:sessions.find(x=>Number(x.id)===Number(filters.sessionId))?.name||"Selected session",summary:{debtors:rows.filter(x=>x.balance>0).length,creditors:rows.filter(x=>x.balance<0).length,totalDebt:rows.reduce((n,x)=>n+Math.max(0,x.balance),0),totalCredit:rows.reduce((n,x)=>n+Math.max(0,-x.balance),0)}};
}

export async function page(req,res,next){try{res.render('payment/debtors-creditors',{layout:'layouts/adminlte',title:'Debtors & Creditors',pageTitle:'Debtors & Creditors',query:req.query,...await reportData(req)});}catch(e){next(e)}}

export async function exportReport(req,res,next){
  try{
    const data=await reportData(req);
    const type=clean(req.query.type).toUpperCase();
    const balanceLabel=type==='DEBTOR'?'Debtors Report':type==='CREDITOR'?'Creditors Report':'Debtors & Creditors Report';
    const reportLabel=`${data.categoryLabel} ${balanceLabel}`;
    const rows=data.rows.filter(x=>!type||(type==='DEBTOR'?x.balance>0:type==='CREDITOR'?x.balance<0:true)).map(x=>({
      Matric:x.matric_number||'',Name:x.full_name||'',School:x.school_name||'',Department:x.department_name||'',Programme:x.programme_name||'',Expected:Number(x.expected||0),Paid:Number(x.paid||0),Balance:Math.abs(Number(x.balance||0)),Status:x.status,Email:x.email||'',Phone:x.phone||''
    }));
    const headers=['Matric','Name','School','Department','Programme','Expected','Paid','Balance','Status','Email','Phone'];
    const subtitle=`Fee: ${data.categoryLabel} | Session: ${data.sessionName} | Generated: ${new Date().toLocaleString('en-GB')}`;
    const format=clean(req.params.format).toLowerCase();

    if(format==='xlsx'){
      const aoa=[
        ['EKITI STATE COLLEGE OF TECHNOLOGY, IJERO-EKITI'],
        ['P.M.B. 316, Epe Ara Road, Ijero-Ekiti, Ekiti State'],
        [reportLabel],
        [subtitle],
        [],
        headers,
        ...rows.map(row=>headers.map(key=>row[key])),
      ];
      const ws=XLSX.utils.aoa_to_sheet(aoa);
      ws['!merges']=[0,1,2,3].map(r=>({s:{r,c:0},e:{r,c:headers.length-1}}));
      ws['!cols']=[{wch:22},{wch:28},{wch:24},{wch:24},{wch:26},{wch:14},{wch:14},{wch:14},{wch:12},{wch:28},{wch:16}];
      ws['!autofilter']={ref:`A6:K${Math.max(6,rows.length+6)}`};
      const wb=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb,ws,'Balances');
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition','attachment; filename="debtors-creditors.xlsx"');
      return res.send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));
    }

    if(format==='pdf'){
      const doc=new PDFDocument({size:'A4',layout:'landscape',margin:30});
      const logo=path.resolve('app/web/public/img/logo-transparent-ui.png');
      const columns=[30,50,120,235,330,420,510,570,630,690];
      const widths=[18,66,110,90,86,86,56,56,56,65];
      const headings=['#','Matric','Name','School','Department','Programme','Expected','Paid','Balance','Status'];
      const drawPageHeader=()=>{
        try{doc.save().opacity(.055).image(logo,300,175,{fit:[240,290],align:'center'}).restore();}catch{}
        try{doc.image(logo,34,28,{fit:[46,50]});}catch{}
        doc.fillColor('#247D57').font('Helvetica-Bold').fontSize(15).text('EKITI STATE COLLEGE OF TECHNOLOGY',90,30,{width:620,align:'center'});
        doc.fillColor('#333').fontSize(9).text('IJERO-EKITI, EKITI STATE',90,50,{width:620,align:'center'}).font('Helvetica').fontSize(8).text('P.M.B. 316, Epe Ara Road, Ijero-Ekiti, Ekiti State',90,64,{width:620,align:'center'});
        doc.fillColor('#82103C').font('Helvetica-Bold').fontSize(13).text(reportLabel,90,82,{width:620,align:'center'});
        doc.fillColor('#555').font('Helvetica').fontSize(8).text(subtitle,90,100,{width:620,align:'center'});
        let y=120;doc.rect(30,y,752,20).fill('#247D57');doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7);headings.forEach((h,i)=>doc.text(h,columns[i],y+6,{width:widths[i],ellipsis:true}));doc.y=145;
      };
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename="debtors-creditors.pdf"');
      doc.pipe(res);drawPageHeader();
      rows.forEach((x,i)=>{
        if(doc.y>545){doc.addPage();drawPageHeader();}
        const y=doc.y;if(i%2===0)doc.rect(30,y-3,752,20).fill('#f2f7f4');doc.fillColor('#222').font('Helvetica').fontSize(6.7);
        const values=[i+1,x.Matric||'-',x.Name,x.School||'-',x.Department||'-',x.Programme||'-',`N${x.Expected.toLocaleString()}`,`N${x.Paid.toLocaleString()}`,`N${x.Balance.toLocaleString()}`,x.Status];
        values.forEach((value,j)=>doc.text(String(value),columns[j],y,{width:widths[j],ellipsis:true,lineBreak:false}));doc.y=y+20;
      });
      if(!rows.length)doc.fillColor('#666').fontSize(10).text('No matching records were found for the selected filters.',30,165,{width:752,align:'center'});
      doc.end();return;
    }

    const q=v=>`"${String(v??'').replace(/"/g,'""')}"`;
    const lines=[
      [q('EKITI STATE COLLEGE OF TECHNOLOGY, IJERO-EKITI')].join(','),
      [q(reportLabel)].join(','),
      [q(subtitle)].join(','),
      '',headers.map(q).join(','),
      ...rows.map(x=>headers.map(h=>q(x[h])).join(',')),
    ];
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="debtors-creditors.csv"');
    return res.send('\uFEFF'+lines.join('\n'));
  }catch(e){next(e)}
}

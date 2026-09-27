import { pool } from "../../core/db.js";
import XLSX from "xlsx";
import PDFDocument from "pdfkit";
import path from "path";

const num = value => Number.parseInt(value,10)||0;
const clean = value => String(value??"").trim();

async function reportData(req){
  const [[current]]=await pool.query(`SELECT id,name FROM sessions WHERE is_current=1 ORDER BY id DESC LIMIT 1`);
  const filters={sessionId:num(req.query.session_id)||num(current?.id),schoolId:num(req.query.school_id),departmentId:num(req.query.department_id),programmeId:num(req.query.programme_id),q:clean(req.query.q).slice(0,120)};
  const params=[];const where=[`(pu.role='student' OR EXISTS(SELECT 1 FROM portal_user_roles pur WHERE pur.public_user_id=pu.id AND pur.role='student'))`];
  if(filters.schoolId){where.push(`sp.school_id=?`);params.push(filters.schoolId)}
  if(filters.departmentId){where.push(`sp.department_id=?`);params.push(filters.departmentId)}
  if(filters.programmeId){where.push(`sp.programme_id=?`);params.push(filters.programmeId)}
  if(filters.q){where.push(`(pu.matric_number LIKE ? OR pu.username LIKE ? OR CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) LIKE ?)`);const t=`%${filters.q}%`;params.push(t,t,t)}
  const [students]=await pool.query(`SELECT pu.id,pu.matric_number,pu.username email,pu.phone,CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) full_name,sp.level,sp.school_id,sp.department_id,sp.programme_id,sc.name school_name,d.name department_name,p.name programme_name FROM public_users pu LEFT JOIN student_profiles sp ON sp.user_id=pu.id LEFT JOIN schools sc ON sc.id=sp.school_id LEFT JOIN departments d ON d.id=sp.department_id LEFT JOIN programmes p ON p.id=sp.programme_id WHERE ${where.join(' AND ')} ORDER BY full_name`,params);
  const [types]=await pool.query(`SELECT pt.* FROM payment_types pt WHERE pt.is_active=1 AND pt.is_compulsory=1 AND (NOT EXISTS(SELECT 1 FROM payment_type_sessions pts0 WHERE pts0.payment_type_id=pt.id) OR EXISTS(SELECT 1 FROM payment_type_sessions pts WHERE pts.payment_type_id=pt.id AND pts.session_id=?))`,[filters.sessionId]);
  const [scopeRows]=await pool.query(`SELECT payment_type_id,'school' kind,school_id target FROM payment_type_schools UNION ALL SELECT payment_type_id,'department',department_id FROM payment_type_departments UNION ALL SELECT payment_type_id,'programme',programme_id FROM payment_type_programmes`);
  const scopes=new Map();for(const x of scopeRows){if(!scopes.has(x.payment_type_id))scopes.set(x.payment_type_id,[]);scopes.get(x.payment_type_id).push(x)}
  const [payments]=students.length?await pool.query(`SELECT pi.*,pt.name payment_name FROM payment_invoices pi JOIN payment_types pt ON pt.id=pi.payment_type_id WHERE pi.status='PAID' AND pi.payment_type_id IN (?) AND (pi.session_id=? OR (pi.session_id IS NULL AND (SELECT COUNT(DISTINCT pts.session_id) FROM payment_type_sessions pts WHERE pts.payment_type_id=pi.payment_type_id)<=1)) AND (pi.payee_id IN (?) OR pi.payee_email IN (?))`,[types.map(x=>x.id).length?types.map(x=>x.id):[0],filters.sessionId,students.flatMap(x=>[String(x.id),x.matric_number,x.email]).filter(Boolean),students.map(x=>x.email).filter(Boolean)]):[[]];
  const applicable=(type,s)=>{const list=scopes.get(type.id)||[];if(!list.length)return true;return list.some(x=>(x.kind==='school'&&Number(x.target)===Number(s.school_id))||(x.kind==='department'&&Number(x.target)===Number(s.department_id))||(x.kind==='programme'&&Number(x.target)===Number(s.programme_id)))};
  const rows=students.map(s=>{const obligations=types.filter(t=>applicable(t,s));const expected=obligations.reduce((sum,t)=>sum+Number(t.amount||0),0);const paid=payments.filter(p=>[String(s.id),clean(s.matric_number).toLowerCase(),clean(s.email).toLowerCase()].includes(clean(p.payee_id).toLowerCase())||clean(p.payee_email).toLowerCase()===clean(s.email).toLowerCase()).reduce((sum,p)=>sum+Number(p.amount||0),0);return {...s,expected,paid,balance:expected-paid,status:expected-paid>0?'DEBTOR':expected-paid<0?'CREDITOR':'CLEARED'};});
  const [[sessions],[schools],[departments],[programmes]]=await Promise.all([pool.query(`SELECT id,name,is_current FROM sessions ORDER BY id DESC`),pool.query(`SELECT id,name FROM schools ORDER BY name`),pool.query(`SELECT id,school_id,name FROM departments ORDER BY name`),pool.query(`SELECT id,school_id,department_id,name FROM programmes ORDER BY name`)]);
  return {rows,filters,sessions,schools,departments,programmes,obligationCount:types.length,sessionName:sessions.find(x=>Number(x.id)===Number(filters.sessionId))?.name||"Selected session",summary:{debtors:rows.filter(x=>x.balance>0).length,creditors:rows.filter(x=>x.balance<0).length,totalDebt:rows.reduce((n,x)=>n+Math.max(0,x.balance),0),totalCredit:rows.reduce((n,x)=>n+Math.max(0,-x.balance),0)}};
}

export async function page(req,res,next){try{res.render('payment/debtors-creditors',{layout:'layouts/adminlte',title:'Debtors & Creditors',pageTitle:'Debtors & Creditors',query:req.query,...await reportData(req)});}catch(e){next(e)}}

export async function exportReport(req,res,next){
  try{
    const data=await reportData(req);
    const type=clean(req.query.type).toUpperCase();
    const reportLabel=type==='DEBTOR'?'Debtors Report':type==='CREDITOR'?'Creditors Report':'Debtors & Creditors Report';
    const rows=data.rows.filter(x=>!type||(type==='DEBTOR'?x.balance>0:type==='CREDITOR'?x.balance<0:true)).map(x=>({
      Matric:x.matric_number||'',Name:x.full_name||'',School:x.school_name||'',Department:x.department_name||'',Programme:x.programme_name||'',Expected:Number(x.expected||0),Paid:Number(x.paid||0),Balance:Math.abs(Number(x.balance||0)),Status:x.status,Email:x.email||'',Phone:x.phone||''
    }));
    const headers=['Matric','Name','School','Department','Programme','Expected','Paid','Balance','Status','Email','Phone'];
    const subtitle=`Session: ${data.sessionName} | Generated: ${new Date().toLocaleString('en-GB')}`;
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

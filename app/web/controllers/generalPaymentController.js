// app/web/controllers/generalPaymentController.js
import * as svc from '../../services/paymentService.js';
import db from '../../core/db.js';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';

function cleanText(v) {
  return String(v || '').trim();
}

function key(v) {
  return cleanText(v).toLowerCase();
}

function fullNameFromUser(u = {}) {
  const user = u || {};
  return [user.first_name, user.middle_name, user.last_name]
    .map(cleanText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkArray(arr, size = 400) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchPublicUsersForPayments(rows = []) {
  const candidates = new Set();

  for (const r of rows) {
    for (const v of [r.payee_id, r.payee_email, r.payee_phone]) {
      const c = cleanText(v);
      if (c) candidates.add(c);
    }
  }

  const all = [...candidates];
  const maps = {
    byMatric: new Map(),
    byEmail: new Map(),
    byPhone: new Map(),
    byId: new Map(),
  };

  if (!all.length) return maps;

  for (const part of chunkArray(all)) {
    const [found] = await db.query(
      `
      SELECT
        id,
        first_name,
        middle_name,
        last_name,
        username,
        phone,
        matric_number
      FROM public_users pu
      WHERE (
          pu.role = 'student'
          OR EXISTS (
            SELECT 1 FROM portal_user_roles pur
            WHERE pur.public_user_id = pu.id AND pur.role = 'student'
          )
        )
        AND (
          matric_number IN (?)
          OR username IN (?)
          OR phone IN (?)
          OR CAST(id AS CHAR) IN (?)
        )
      `,
      [part, part, part, part]
    );

    for (const u of found || []) {
      if (cleanText(u.matric_number)) maps.byMatric.set(key(u.matric_number), u);
      if (cleanText(u.username)) maps.byEmail.set(key(u.username), u);
      if (cleanText(u.phone)) maps.byPhone.set(key(u.phone), u);
      maps.byId.set(String(u.id), u);
    }
  }

  return maps;
}

async function fetchStudentImportDepartments(rows = [], userMaps) {
  const matrics = new Set();
  const emails = new Set();

  for (const r of rows) {
    const payeeId = cleanText(r.payee_id);
    const email = cleanText(r.payee_email);

    if (payeeId) matrics.add(payeeId);
    if (email) emails.add(email);

    const u =
      userMaps.byMatric.get(key(payeeId)) ||
      userMaps.byEmail.get(key(payeeId)) ||
      userMaps.byEmail.get(key(email)) ||
      userMaps.byPhone.get(key(r.payee_phone)) ||
      userMaps.byId.get(payeeId);

    if (u?.matric_number) matrics.add(cleanText(u.matric_number));
    if (u?.username) emails.add(cleanText(u.username));
  }

  const maps = {
    byMatric: new Map(),
    byEmail: new Map(),
  };

  for (const part of chunkArray([...matrics].filter(Boolean))) {
    const [found] = await db.query(
      `
      SELECT matric_number, student_email, department
      FROM student_imports
      WHERE matric_number IN (?)
      `,
      [part]
    );

    for (const row of found || []) {
      if (cleanText(row.matric_number) && cleanText(row.department)) {
        maps.byMatric.set(key(row.matric_number), cleanText(row.department));
      }
      if (cleanText(row.student_email) && cleanText(row.department)) {
        maps.byEmail.set(key(row.student_email), cleanText(row.department));
      }
    }
  }

  for (const part of chunkArray([...emails].filter(Boolean))) {
    const [found] = await db.query(
      `
      SELECT matric_number, student_email, department
      FROM student_imports
      WHERE student_email IN (?)
      `,
      [part]
    );

    for (const row of found || []) {
      if (cleanText(row.matric_number) && cleanText(row.department)) {
        maps.byMatric.set(key(row.matric_number), cleanText(row.department));
      }
      if (cleanText(row.student_email) && cleanText(row.department)) {
        maps.byEmail.set(key(row.student_email), cleanText(row.department));
      }
    }
  }

  return maps;
}

async function enrichPaymentExportRows(rows = []) {
  const userMaps = await fetchPublicUsersForPayments(rows);
  const deptMaps = await fetchStudentImportDepartments(rows, userMaps);

  return rows.map((r) => {
    const payeeId = cleanText(r.payee_id);
    const email = cleanText(r.payee_email);
    const phone = cleanText(r.payee_phone);

    const u =
      userMaps.byMatric.get(key(payeeId)) ||
      userMaps.byEmail.get(key(payeeId)) ||
      userMaps.byEmail.get(key(email)) ||
      userMaps.byPhone.get(key(phone)) ||
      userMaps.byId.get(payeeId) ||
      null;

    const matric = cleanText(u?.matric_number) || payeeId;
    const resolvedEmail = cleanText(u?.username) || email;

    const resolvedName = fullNameFromUser(u) || cleanText(r.payee_fullname);
    const firstName = cleanText(u?.first_name);
    const middleName = cleanText(u?.middle_name);
    const lastName = cleanText(u?.last_name);

    const department =
      deptMaps.byMatric.get(key(matric)) ||
      deptMaps.byEmail.get(key(resolvedEmail)) ||
      '';

    return {
      ...r,
      export_payee_fullname: resolvedName,
      export_first_name: firstName,
      export_middle_name: middleName,
      export_last_name: lastName,
      export_department: department,
    };
  });
}

// Admin – All / General Payment (report)
export async function index(req, res, next){
  try {
    const page   = Number(req.query.page || 1);
    const q      = String(req.query.q || '').trim();
    const from   = req.query.from || '';
    const to     = req.query.to || '';
    const status = (req.query.status || 'ALL').toUpperCase();   // ALL | PENDING | PAID
    const method = (req.query.method || 'ALL').toUpperCase();   // ALL | ONLINE | BANK
    const typeId = req.query.typeId || '';

    const data = await svc.listInvoices({
      page, pageSize: 20, q, from, to, status, method, typeId
    });

    const types = await svc.listActivePaymentTypes(); // for dropdown

    res.render('payment/admin-payments-list', {
      title: 'All / General Payment',
      q, from, to, status, method, typeId,
      types,
      ...data,
      messages: req.flash?.() || {},
    });
  } catch (e) {
    next(e);
  }
}

// CSV export (updated to include RRR + Name and relabel Payee ID / Matric)
export async function exportCsv(req, res, next){
  try {
    const q      = String(req.query.q || '').trim();
    const from   = req.query.from || '';
    const to     = req.query.to || '';
    const status = (req.query.status || 'ALL').toUpperCase();
    const method = (req.query.method || 'ALL').toUpperCase();
    const typeId = req.query.typeId || '';

    const data = await svc.listInvoices({
      page: 1,
      pageSize: 100000,
      exportAll: true,
      q,
      from,
      to,
      status,
      method,
      typeId,
    });

    const rows = await enrichPaymentExportRows(data.rows || []);
    const header = [
      'Order ID','RRR','Payment Type','Amount','Portal Charge','Method','Status',
      'Full Name','First Name','Middle Name','Last Name','Payee ID / Matric','Department','Email','Phone','Created At'
    ];

    const csv = [
      header.join(','),
      ...rows.map(r => [
        r.order_id, r.rrr || '',
        r.payment_type_name,
        r.amount, r.portal_charge, r.method, r.status,
        r.export_payee_fullname || r.payee_fullname || '',
        r.export_first_name || '',
        r.export_middle_name || '',
        r.export_last_name || '',
        r.payee_id || '',
        r.export_department || '',
        r.payee_email || '',
        r.payee_phone || '',
        (r.created_at ? new Date(r.created_at).toISOString() : '')
      ].map(v => {
        const text = String(v);
        const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
        return `"${safe.replace(/"/g,'""')}"`;
      }).join(','))
    ].join('\n');

    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="payments.csv"');
    res.send(csv);
  } catch (e) {
    next(e);
  }
}

async function filteredExportRows(req) {
  const data=await svc.listInvoices({page:1,pageSize:100000,exportAll:true,q:String(req.query.q||'').trim(),from:req.query.from||'',to:req.query.to||'',status:String(req.query.status||'ALL').toUpperCase(),method:String(req.query.method||'ALL').toUpperCase(),typeId:req.query.typeId||''});
  return enrichPaymentExportRows(data.rows||[]);
}

function paymentObjects(rows){const safe=v=>{const text=String(v??'');return /^[=+\-@\t\r]/.test(text)?`'${text}`:text;};return rows.map(r=>({"Order ID":safe(r.order_id),"RRR":safe(r.rrr),"Payment Type":safe(r.payment_type_name),"Amount":Number(r.amount||0),"Portal Charge":Number(r.portal_charge||0),"Method":r.method,"Status":r.status,"Full Name":safe(r.export_payee_fullname||r.payee_fullname),"First Name":safe(r.export_first_name),"Middle Name":safe(r.export_middle_name),"Last Name":safe(r.export_last_name),"Payee ID / Matric":safe(r.payee_id),"Department":safe(r.export_department),"Email":safe(r.payee_email),"Phone":safe(r.payee_phone),"Created At":r.created_at?new Date(r.created_at).toISOString():''}));}

export async function exportXlsx(req,res,next){try{const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(paymentObjects(await filteredExportRows(req))),'Payments');const buffer=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="payments.xlsx"');res.send(buffer);}catch(error){next(error);}}

export async function exportPdf(req,res,next){try{const rows=await filteredExportRows(req);const doc=new PDFDocument({size:'A4',layout:'landscape',margin:28});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="payments.pdf"');doc.pipe(res);doc.font('Helvetica-Bold').fontSize(15).fillColor('#247D57').text('All Payment History',{align:'center'});doc.font('Helvetica').fontSize(8).fillColor('#555').text(`${rows.length} record(s) · Generated ${new Date().toLocaleString('en-GB')}`,{align:'center'});let y=85;const headers=['#','Order ID','RRR','Type','Payee','ID/Matric','Amount','Charge','Method','Status','Date'],cols=[28,55,135,205,300,410,485,540,595,645,700],widths=[25,78,68,93,108,73,53,53,48,53,80];const head=()=>{doc.rect(28,y,758,18).fill('#247D57');doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7);headers.forEach((h,i)=>doc.text(h,cols[i],y+5,{width:widths[i]}));y+=21};head();rows.forEach((r,i)=>{if(y>545){doc.addPage();y=30;head();}if(i%2===0)doc.rect(28,y-2,758,18).fill('#f4f6f9');doc.fillColor('#222').font('Helvetica').fontSize(6.5);[i+1,r.order_id,r.rrr||'',r.payment_type_name,r.export_payee_fullname||r.payee_fullname,r.payee_id,Number(r.amount||0).toFixed(2),Number(r.portal_charge||0).toFixed(2),r.method,r.status,r.created_at?new Date(r.created_at).toLocaleDateString('en-GB'):''].forEach((v,j)=>doc.text(String(v||''),cols[j],y,{width:widths[j],ellipsis:true}));y+=18});doc.end();}catch(error){next(error);}}

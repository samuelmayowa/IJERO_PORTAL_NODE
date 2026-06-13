// app/web/controllers/generalPaymentController.js
import * as svc from '../../services/paymentService.js';

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
      page:1, pageSize: 100000, q, from, to, status, method, typeId
    });

    const rows = data.rows || [];
    const header = [
      'Order ID','RRR','Payment Type','Amount','Portal Charge','Method','Status',
      'Name','Payee ID / Matric','Email','Phone','Created At'
    ];

    const csv = [
      header.join(','),
      ...rows.map(r => [
        r.order_id, r.rrr || '',
        r.payment_type_name,
        r.amount, r.portal_charge, r.method, r.status,
        r.payee_fullname || '',
        r.payee_id || '',
        r.payee_email || '',
        r.payee_phone || '',
        (r.created_at ? new Date(r.created_at).toISOString() : '')
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))
    ].join('\n');

    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="payments.csv"');
    res.send(csv);
  } catch (e) {
    next(e);
  }
}

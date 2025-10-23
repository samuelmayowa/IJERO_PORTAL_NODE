// app/web/controllers/paymentTypeController.js  (ESM)
import * as PaymentTypes from '../../services/paymentTypeService.js';
import db from '../../core/db.js';

function toRows(x) {
  if (Array.isArray(x) && Array.isArray(x[0])) return x[0];
  return x || [];
}

// Load dropdown metadata for the form
async function getMeta() {
  const [schoolsR, departmentsR, sessionsR] = await Promise.all([
    db.query('SELECT id, name FROM schools ORDER BY name ASC'),
    db.query('SELECT id, name FROM departments ORDER BY name ASC'),
    db.query('SELECT id, name FROM sessions ORDER BY id DESC'),
  ]);
  return {
    schools: toRows(schoolsR),
    departments: toRows(departmentsR),
    sessions: toRows(sessionsR),
  };
}

export async function index(req, res) {
  const page = Number(req.query.page || 1);
  const q = String(req.query.q || '').trim();

  const data = await PaymentTypes.list({ page, pageSize: 20, q });
  const meta = await getMeta();

  res.render('payment/payment-types-list', {
    title: 'Payment Types',
    ...data,
    q,
    ...meta,
    messages: req.flash?.() || {},
    currentPath: req.path,
  });
}

export async function addForm(req, res) {
  const meta = await getMeta();
  res.render('payment/payment-type-form', {
    title: 'Add Payment Type',
    form: { scope: 'GENERAL', is_active: 1 },
    ...meta,
    messages: req.flash?.() || {},
    csrfToken: req.csrfToken?.(),
    currentPath: req.path,
  });
}

export async function editForm(req, res) {
  const id = Number(req.params.id);
  const row = await PaymentTypes.get(id);
  if (!row) {
    req.flash?.('error', 'Payment type not found');
    return res.redirect('/staff/fees/payment-types');
  }
  const meta = await getMeta();
  res.render('payment/payment-type-form', {
    title: 'Edit Payment Type',
    form: row,
    ...meta,
    messages: req.flash?.() || {},
    csrfToken: req.csrfToken?.(),
    currentPath: req.path,
  });
}

export async function create(req, res) {
  try {
    await PaymentTypes.create(req.body, req.user && req.user.id);
    req.flash?.('success', 'Payment type created.');
    res.redirect('/staff/fees/payment-types');
  } catch (e) {
    req.flash?.('error', e.message || 'Failed to create payment type');
    res.redirect('/staff/fees/payment-types/add');
  }
}

export async function update(req, res) {
  const id = Number(req.params.id);
  try {
    await PaymentTypes.update(id, req.body);
    req.flash?.('success', 'Payment type updated.');
  } catch (e) {
    req.flash?.('error', e.message || 'Failed to update payment type');
  }
  res.redirect('/staff/fees/payment-types');
}

// app/web/routes/payment.routes.js
import { Router } from 'express';
import {
  paymentForm,
  createInvoice,
  reprintForm,
  reprintDownload,
  fetchType,
  print,
  remitaCallback
} from '../controllers/publicPaymentController.js';

const r = Router();

// Public payment & reprint pages
r.get('/payment', paymentForm);
r.post('/payment', createInvoice);
r.get('/payment/reprint', reprintForm);
r.post('/payment/reprint', reprintDownload);

// Ajax: get payment type details (amount, charge)
r.get('/payment/api/payment-types/:id', fetchType);

// View/Download (stream real PDF)
r.get('/payment/print/:orderId', print);

// Remita return URL (configure REMITA_RETURN_URL to this)
r.get('/payment/remita/callback', remitaCallback);

export default r;

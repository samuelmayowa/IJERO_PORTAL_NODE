// app/web/routes/payment.routes.js
import { Router } from 'express';
import {
  paymentForm,
  createInvoice,
  reprintForm,
  reprintDownload,
  fetchType,
  print,
  remitaCallback,
  forwardToRemita,   // single, named import
} from '../controllers/publicPaymentController.js';

const r = Router();

// Public payment & reprint pages
r.get('/payment', paymentForm);
r.post('/payment', createInvoice);
r.get('/payment/reprint', reprintForm);
r.post('/payment/reprint', reprintDownload);

// Ajax: get payment type details (amount, charge)
r.get('/payment/api/payment-types/:id', fetchType);

// View/Download invoice/receipt
r.get('/payment/print/:orderId', print);

// Remita return URL (must match REMITA_RETURN_URL in .env)
r.get('/payment/remita/callback', remitaCallback);

// Forward the user to Remita via auto-POST form
r.get('/payment/forward/:rrr', forwardToRemita);

export default r;

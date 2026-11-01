import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAcceptancePaymentOrders } from '../app/services/applicationAcceptancePaymentService.js';

test('paid primary fee with an outstanding variation starts a new variation', () => {
  const result = selectAcceptancePaymentOrders({
    outstanding: 5000,
    payments: [
      { order_id: 'PAID-65000', status: 'PAID' },
    ],
  });

  assert.equal(result.pendingOrderId, null);
  assert.equal(result.receiptOrderId, 'PAID-65000');
});

test('an existing pending variation is resumed instead of duplicated', () => {
  const result = selectAcceptancePaymentOrders({
    outstanding: 5000,
    payments: [
      { order_id: 'PAID-65000', status: 'PAID' },
      { order_id: 'VARIATION-5000', status: 'PENDING' },
    ],
  });

  assert.equal(result.pendingOrderId, 'VARIATION-5000');
  assert.equal(result.receiptOrderId, 'PAID-65000');
});

test('a fully paid fee exposes only its receipt', () => {
  const result = selectAcceptancePaymentOrders({
    outstanding: 0,
    payments: [
      { order_id: 'PAID-65000', status: 'PAID' },
      { order_id: 'VARIATION-5000', status: 'PAID' },
    ],
  });

  assert.equal(result.pendingOrderId, null);
  assert.equal(result.receiptOrderId, 'VARIATION-5000');
});

test('failed invoices are not presented as resumable payments', () => {
  const result = selectAcceptancePaymentOrders({
    outstanding: 5000,
    payments: [
      { order_id: 'FAILED-VARIATION', status: 'FAILED' },
    ],
  });

  assert.equal(result.pendingOrderId, null);
  assert.equal(result.receiptOrderId, null);
});

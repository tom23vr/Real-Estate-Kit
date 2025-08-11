import test from 'node:test';
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:5173';

test('create checkout session (bad request without email)', async () => {
  const r = await fetch(BASE + '/api/create-checkout-session', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});
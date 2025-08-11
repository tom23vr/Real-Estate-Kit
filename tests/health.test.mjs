import test from 'node:test';
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:5173';

test('health ok', async () => {
  const r = await fetch(BASE + '/api/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
});
import { test } from 'node:test';
import assert from 'node:assert';
import { pool } from '../db/connection.js';
import { withIdempotency } from '../middlewares/idempotency.js';

// Mock Express req/res
function createMockReq(headers: Record<string, string>, path: string, method: string = 'POST', body: any = {}, query: any = {}) {
  return {
    header: (k: string) => headers[k] || headers[k.toLowerCase()],
    originalUrl: path,
    method,
    body,
    query
  } as any;
}

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
    json: (body: any) => {
      res.body = body;
      return res;
    }
  };
  return res;
}

test('Idempotency Middleware', async (t) => {
  await pool.query('DELETE FROM idempotency_keys');

  await t.test('missing Idempotency-Key behaviour is explicit and tested', async () => {
    const req = createMockReq({}, '/sync');
    const res = createMockRes();
    let executions = 0;

    await withIdempotency(req, res, 'sync_all', async () => {
      executions++;
      return { status: 200, body: { ok: true } };
    });

    assert.equal(executions, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  await t.test('first request with a key executes the sync', async () => {
    const req = createMockReq({ 'Idempotency-Key': 'key-1' }, '/sync');
    const res = createMockRes();
    let executions = 0;

    await withIdempotency(req, res, 'sync_all', async () => {
      executions++;
      return { status: 200, body: { result: 'first' } };
    });

    assert.equal(executions, 1);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result, 'first');
  });

  await t.test('repeated identical request returns the stored response without re-executing', async () => {
    const req = createMockReq({ 'Idempotency-Key': 'key-1' }, '/sync');
    const res = createMockRes();
    let executions = 0;

    await withIdempotency(req, res, 'sync_all', async () => {
      executions++;
      return { status: 200, body: { result: 'second' } };
    });

    assert.equal(executions, 0); // Should not execute
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result, 'first'); // Replayed from DB
  });

  await t.test('completed failed-sync response is replayed consistently', async () => {
    const req = createMockReq({ 'Idempotency-Key': 'key-fail' }, '/sync');
    let executions = 0;
    
    // First run
    const res1 = createMockRes();
    await withIdempotency(req, res1, 'sync_all', async () => {
      executions++;
      return { status: 500, body: { error: 'failed' } };
    });
    
    assert.equal(executions, 1);
    assert.equal(res1.statusCode, 500);
    
    // Second run
    const res2 = createMockRes();
    await withIdempotency(req, res2, 'sync_all', async () => {
      executions++;
      return { status: 500, body: { error: 'new error' } };
    });
    
    assert.equal(executions, 1); // No new execution
    assert.equal(res2.statusCode, 500);
    assert.equal(res2.body.error, 'failed'); // Replayed failure
  });

  await t.test('same key with a different operation does not collide', async () => {
    const req = createMockReq({ 'Idempotency-Key': 'key-1' }, '/sync/square');
    const res = createMockRes();
    let executions = 0;

    await withIdempotency(req, res, 'sync_square', async () => {
      executions++;
      return { status: 200, body: { result: 'square' } };
    });

    assert.equal(executions, 1); // Executes because operation is different
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result, 'square');
  });

  await t.test('conflicting fingerprint for the same key and operation returns 409', async () => {
    // Pass a different query object so the fingerprint string changes
    const req = createMockReq({ 'Idempotency-Key': 'key-1' }, '/sync', 'POST', {}, { diff: true });
    const res = createMockRes();
    let executions = 0;

    await withIdempotency(req, res, 'sync_all', async () => {
      executions++;
      return { status: 200, body: { ok: true } };
    });

    assert.equal(executions, 0); // Does not execute
    assert.equal(res.statusCode, 409); // Conflict returned
    assert.equal(res.body.error, 'Idempotency key already used for a different request fingerprint.');
  });

  await t.test('two concurrent requests using the same key cannot both execute the sync', async () => {
    const req1 = createMockReq({ 'Idempotency-Key': 'key-concurrent' }, '/sync');
    const req2 = createMockReq({ 'Idempotency-Key': 'key-concurrent' }, '/sync');
    const res1 = createMockRes();
    const res2 = createMockRes();
    let executions = 0;
    
    let executeResolve: () => void;
    const executePromise = new Promise<void>(resolve => { executeResolve = resolve; });

    // Start request 1 (it will block inside execution)
    const p1 = withIdempotency(req1, res1, 'sync_all', async () => {
      executions++;
      await executePromise; 
      return { status: 200, body: { r: 1 } };
    });

    // Wait a tiny bit to ensure p1 inserts the lock
    await new Promise(r => setTimeout(r, 100));

    // Start request 2
    const p2 = withIdempotency(req2, res2, 'sync_all', async () => {
      executions++;
      return { status: 200, body: { r: 2 } };
    });
    
    // p2 should resolve immediately with 409
    await p2;
    assert.equal(res2.statusCode, 409);
    assert.equal(res2.body.error, 'A request with this idempotency key is currently processing.');

    // Now unblock p1
    executeResolve!();
    await p1;
    
    assert.equal(executions, 1);
    assert.equal(res1.statusCode, 200);
  });

  await t.test('stale/crashed processing-state behaviour matches the documented policy', async () => {
    const req = createMockReq({ 'Idempotency-Key': 'key-stale' }, '/sync');
    const res1 = createMockRes();
    const res2 = createMockRes();
    let executions = 0;

    // Simulate a crash: run but throw before returning
    try {
      await withIdempotency(req, res1, 'sync_all', async () => {
        executions++;
        throw new Error('Crash!');
      });
    } catch (e) {}

    assert.equal(executions, 1);

    // Now it's stuck in processing. A regular attempt yields 409.
    await withIdempotency(req, res2, 'sync_all', async () => {
      executions++;
      return { status: 200, body: {} };
    });
    assert.equal(res2.statusCode, 409); // Active processing
    assert.equal(executions, 1); // Not executed

    // Manually backdate the created_at to 6 minutes ago
    await pool.query("UPDATE idempotency_keys SET created_at = NOW() - INTERVAL '6 minutes' WHERE idempotency_key = 'key-stale'");

    // Now attempt again, it should STILL yield 409 because we never automatically steal
    const res3 = createMockRes();
    await withIdempotency(req, res3, 'sync_all', async () => {
      executions++;
      return { status: 200, body: { recovered: true } };
    });

    assert.equal(executions, 1); // STILL not executed
    assert.equal(res3.statusCode, 409);
    assert.equal(res3.body.error, 'A request with this idempotency key is currently processing.');
  });
});

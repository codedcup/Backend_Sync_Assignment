import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import crypto from 'crypto';

export type IdempotencyExecutionResult = {
  status: number;
  body: any;
};

/**
 * Wraps an HTTP handler with request-level idempotency.
 * 
 * @param req The Express request
 * @param res The Express response
 * @param operation The logical operation scope (e.g., 'sync_all', 'sync_square')
 * @param execute The actual operation to run if the key is successfully claimed
 */
export async function withIdempotency(
  req: Request,
  res: Response,
  operation: string,
  execute: () => Promise<IdempotencyExecutionResult>
): Promise<void> {
  const idempotencyKey = req.header('Idempotency-Key');

  // If no idempotency key is provided, execute without idempotency guarantees
  if (!idempotencyKey) {
    const result = await execute();
    res.status(result.status).json(result.body);
    return;
  }

  // Create a request fingerprint based on method, URL path, and query params
  // Body is not included because /sync doesn't take a body in this assignment,
  // but this is extensible.
  const fingerprintSource = `${req.method}:${req.originalUrl.split('?')[0]}:${JSON.stringify(req.query)}:${JSON.stringify(req.body)}`;
  const fingerprint = crypto.createHash('sha256').update(fingerprintSource).digest('hex');

  // 1. Attempt to atomically claim the idempotency key for this operation
  const insertResult = await pool.query(`
    INSERT INTO idempotency_keys (idempotency_key, operation, fingerprint, status, created_at, updated_at)
    VALUES ($1, $2, $3, 'processing', NOW(), NOW())
    ON CONFLICT (idempotency_key, operation) DO NOTHING
    RETURNING *;
  `, [idempotencyKey, operation, fingerprint]);

  let lockAcquired = insertResult.rowCount !== null && insertResult.rowCount > 0;
  let existingRecord: any = null;

  // 2. If we didn't acquire the lock, inspect the existing record
  if (!lockAcquired) {
    const selectResult = await pool.query(
      'SELECT * FROM idempotency_keys WHERE idempotency_key = $1 AND operation = $2',
      [idempotencyKey, operation]
    );
    existingRecord = selectResult.rows[0];

    if (!existingRecord) {
      // Very rare race condition: it was deleted just after we failed to insert.
      // We will just return 500 so the client can try again.
      res.status(500).json({ error: 'Internal idempotency state error.' });
      return;
    }

    // Check fingerprint collision
    if (existingRecord.fingerprint !== fingerprint) {
      res.status(409).json({ error: 'Idempotency key already used for a different request fingerprint.' });
      return;
    }

    // 3. Handle 'completed' state
    if (existingRecord.status === 'completed') {
      res.status(existingRecord.http_status).json(existingRecord.response_body);
      return;
    }

    // 4. Handle 'processing' state (concurrent duplicate or crashed process)
    if (existingRecord.status === 'processing') {
      res.status(409).json({ error: 'A request with this idempotency key is currently processing.' });
      return;
    }
  }

  // 5. If we reach here, we hold the lock. Execute the operation.
  if (lockAcquired) {
    try {
      const executionResult = await execute();

      // Atomically mark completed and store response
      await pool.query(`
        UPDATE idempotency_keys
        SET status = 'completed', http_status = $3, response_body = $4, updated_at = NOW()
        WHERE idempotency_key = $1 AND operation = $2
      `, [idempotencyKey, operation, executionResult.status, JSON.stringify(executionResult.body)]);

      res.status(executionResult.status).json(executionResult.body);
    } catch (err: unknown) {
      // If the operation threw an unhandled exception, we leave the status as 'processing'.
      // It will remain permanently locked until manual administrative cleanup.
      // This is a strict safeguard against concurrent execution.
      throw err; // Propagate to Express global error handler
    }
  }
}

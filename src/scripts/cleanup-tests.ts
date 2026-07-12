import { Pool } from 'pg';
import { config } from '../config/index.js';

async function cleanup() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    console.log('Cleaning up test fixtures...');
    const delStates = await pool.query(`DELETE FROM sync_states WHERE cursor IN ('cursor-mixed', 'sync:token1', 'sync:token2', 'sync:token3_old', 'sync:token4_old', 'sync:stale_token', 'sync:should_not_save', 'hs:done') OR cursor LIKE 'page:token%'`);
    console.log(`Deleted ${delStates.rowCount} synthetic sync_states.`);

    const delNorm = await pool.query(`DELETE FROM normalized_records WHERE external_id IN ('ext-good-1', 'ext-good-2', 'err', 'evt1', 'evt2', 'evt4', 'p1', 'p2', 'existing', 'hs-1', 'hs-2')`);
    console.log(`Deleted ${delNorm.rowCount} synthetic normalized_records.`);

    const delRej = await pool.query(`DELETE FROM rejected_records WHERE external_id IN ('ext-bad', 'err', 'hs-bad') OR failure_reason = 'Corrupt payload'`);
    console.log(`Deleted ${delRej.rowCount} synthetic rejected_records.`);
    
    const delPay = await pool.query(`DELETE FROM payments WHERE external_id IN ('sq1', 'sq2', 'sq3', 'sq4', 'sq5')`);
    console.log(`Deleted ${delPay.rowCount} synthetic payments.`);
  } finally {
    await pool.end();
  }
}

cleanup().catch(console.error);

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

/**
 * Run a query. Optionally pass userId to set RLS context.
 */
async function query(sql, params, userId) {
  const client = await pool.connect();
  try {
    if (userId) {
      await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
    }
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

/**
 * Run multiple queries in a transaction.
 * fn receives a client and must return a promise.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction };

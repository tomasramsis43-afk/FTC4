// اتصال قاعدة البيانات (Neon/Postgres) — Pool واحد يُستخدم في كل السيرفر
// DATABASE_URL بيتحط في متغيرات البيئة (Render dashboard)، مش في الكود أبداً
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false,
});

// نستخدم client صريح للعمليات اللي محتاجة transaction واحدة (زي إدخال قيد يومية بكل سطوره
// معاً — راجع docs/SCHEMA.md قسم 7 وتريجر check_journal_entry_balanced في migration 001)
async function withTransaction(fn) {
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

module.exports = { pool, withTransaction };

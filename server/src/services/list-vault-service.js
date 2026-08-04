// قراءة حركات الخزينة + حساب الأرصدة لكل وجهة — راجع docs/LOGIC.md §2
const { pool } = require('../db');
const { num } = require('../core-financial');

async function balancesByDestination() {
  const { rows } = await pool.query(`
    SELECT destination,
           COALESCE(SUM(amount) FILTER (WHERE tx_type='in'),0) -
           COALESCE(SUM(amount) FILTER (WHERE tx_type='out'),0) AS balance
    FROM vault_transactions WHERE deleted_at IS NULL
    GROUP BY destination
  `);
  const map = { vault: 0, bank: 0, network: 0, other: 0 };
  rows.forEach(r => { map[r.destination] = num(r.balance); });
  return map;
}

async function listVaultTransactions({ destination, page = 1, pageSize = 30 }) {
  const conditions = ['vt.deleted_at IS NULL'];
  const params = [];
  if (destination) {
    params.push(destination);
    conditions.push(`vt.destination = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows: countRows } = await pool.query(`SELECT count(*) AS c FROM vault_transactions vt ${where}`, params);
  const total = parseInt(countRows[0].c, 10);

  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);
  const { rows } = await pool.query(
    `SELECT vt.*, c.name AS client_name
     FROM vault_transactions vt
     LEFT JOIN clients c ON c.id = vt.client_id
     ${where}
     ORDER BY vt.tx_date DESC, vt.seq DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { data: rows, page, pageSize, total, balances: await balancesByDestination() };
}

module.exports = { listVaultTransactions, balancesByDestination };

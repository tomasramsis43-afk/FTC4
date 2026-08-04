// سجل المشتريات — راجع docs/LOGIC.md §12
const { pool } = require('../db');

async function listPurchases({ page = 1, pageSize = 20 }) {
  const offset = (page - 1) * pageSize;
  const { rows: countRows } = await pool.query('SELECT count(*) AS c FROM purchases');
  const total = parseInt(countRows[0].c, 10);

  const { rows } = await pool.query(
    `SELECT p.*, s.name AS supplier_name
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
     ORDER BY p.purchase_date DESC LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );
  return { data: rows, page, pageSize, total };
}

module.exports = { listPurchases };

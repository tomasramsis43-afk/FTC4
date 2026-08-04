// سجل العملاء — قراءة مع فلاتر وترقيم صفحات وحساب الأرصدة لكل صف
// راجع docs/LOGIC.md §5 للمعادلات المستخدمة هنا
const { pool } = require('../db');
const { num, centerIncome, bagAmount, totalDue } = require('../core-financial');

async function listClients({ search, clientType, hasBalance, page = 1, pageSize = 20 }) {
  const conditions = ['cancelled = false'];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR client_id ILIKE $${params.length})`);
  }
  if (clientType) {
    params.push(clientType);
    conditions.push(`client_type = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows: countRows } = await pool.query(`SELECT count(*) AS c FROM clients ${where}`, params);
  const total = parseInt(countRows[0].c, 10);

  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);
  const { rows } = await pool.query(
    `SELECT * FROM clients ${where} ORDER BY registration_date DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // paidTotal محتاج استعلام منفصل لكل عميل (حالة حوالة الشركة الخاصة — LOGIC.md §5)
  // بنعملها بدفعة واحدة (batch) بدل استعلام لكل صف عشان الأداء
  const clientIds = rows.filter(c => c.client_id && !c.company_transfer_allocated).map(c => c.id);
  let paidMap = {};
  if (clientIds.length) {
    const { rows: paidRows } = await pool.query(
      `SELECT client_id,
              COALESCE(SUM(amount) FILTER (WHERE tx_type='in'), 0) -
              COALESCE(SUM(amount) FILTER (WHERE tx_type='out' AND is_return=true), 0) AS paid
       FROM vault_transactions
       WHERE client_id = ANY($1) AND deleted_at IS NULL
       GROUP BY client_id`,
      [clientIds]
    );
    paidMap = Object.fromEntries(paidRows.map(r => [r.client_id, Math.max(0, num(r.paid))]));
  }

  const enriched = rows.map(c => {
    const total = totalDue(c);
    let paid;
    if (!c.client_id || c.company_transfer_allocated) paid = num(c.paid) + num(c.paid2);
    else paid = paidMap[c.id] || 0;
    const remaining = Math.max(0, total - paid);
    return {
      ...c,
      centerIncome: centerIncome(c),
      bagAmount: bagAmount(c),
      total,
      paid,
      remaining,
      status: remaining <= 0 ? 'paid' : (c.credit_days > 0 ? 'pending' : 'overdue'),
    };
  });

  const filtered = hasBalance ? enriched.filter(c => c.remaining > 0) : enriched;

  return { data: filtered, page, pageSize, total };
}

module.exports = { listClients };

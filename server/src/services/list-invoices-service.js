// سجل الفواتير — العملاء اللي ليهم رقم فاتورة رسمي مُخصّص فعلاً
// راجع docs/LOGIC.md §6.3 لمعادلة ظهور الحقيبة وفك تضمين الضريبة
const { pool } = require('../db');
const { num, vatFromGross, centerIncome, bagAmount, totalDue } = require('../core-financial');

async function paidTotalFor(client) {
  if (!client.client_id || client.company_transfer_allocated) return num(client.paid) + num(client.paid2);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE tx_type='in'),0) -
            COALESCE(SUM(amount) FILTER (WHERE tx_type='out' AND is_return=true),0) AS paid
     FROM vault_transactions WHERE client_id = $1 AND deleted_at IS NULL`,
    [client.id]
  );
  return Math.max(0, num(rows[0].paid));
}

function invoiceBreakdown(client, paid) {
  const income = centerIncome(client);
  const bag = bagAmount(client);
  // §6.3: الحقيبة تظهر في الفاتورة فقط لو اتحصّلت بالكامل مع الدورة معاً
  const bagShown = bag > 0 && paid >= (income + bag);
  const totalInclVat = income + (bagShown ? bag : 0);
  const vat = vatFromGross(totalInclVat);
  const netAmount = totalInclVat - vat;
  return { bagShown, totalInclVat, vat, netAmount };
}

async function listInvoices({ page = 1, pageSize = 20 }) {
  const offset = (page - 1) * pageSize;
  const { rows: countRows } = await pool.query(
    `SELECT count(*) AS c FROM clients WHERE tax_invoice_no IS NOT NULL AND cancelled = false`
  );
  const total = parseInt(countRows[0].c, 10);

  const { rows } = await pool.query(
    `SELECT * FROM clients WHERE tax_invoice_no IS NOT NULL AND cancelled = false
     ORDER BY tax_invoice_no DESC LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );

  const data = [];
  for (const c of rows) {
    const paid = await paidTotalFor(c);
    const breakdown = invoiceBreakdown(c, paid);
    data.push({
      id: c.id, invoiceNo: c.tax_invoice_no, invoiceDate: c.tax_invoice_date,
      clientName: c.name, courseType: c.course_type, paid, remaining: Math.max(0, totalDue(c) - paid),
      ...breakdown,
    });
  }
  return { data, page, pageSize, total };
}

module.exports = { listInvoices, invoiceBreakdown, paidTotalFor };

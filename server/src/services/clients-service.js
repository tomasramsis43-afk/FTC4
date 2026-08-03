// خدمة حساب أرصدة العميل — منطق paidTotal منقول حرفياً من LOGIC.md §5
// (بما فيها الحالة الخاصة لعملاء حوالات الشركات — أهم نقطة هشاشة لو اتنقلت غلط)
const { pool } = require('../db');
const { num, centerIncome, bagAmount, totalDue } = require('../core-financial');

async function paidTotal(client) {
  // عميل بدون رقم هوية: بنثق بحقلي paid/paid2 مباشرة (دفعات تسجيل يدوية)
  if (!client.client_id) return num(client.paid) + num(client.paid2);

  // ⚠️ عميل مُرحّل من حوالة شركة: مبلغه مش قيد منفصل في الخزينة بنفس رقم هويته
  // (القيد موحّد لكل الحوالة — LOGIC.md §2.4) فبنثق بـ paid/paid2 المُزامَنة بدل البحث في الخزينة
  if (client.company_transfer_allocated) return num(client.paid) + num(client.paid2);

  const { rows: inRows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM vault_transactions
     WHERE client_id = $1 AND tx_type = 'in' AND deleted_at IS NULL`,
    [client.id]
  );
  const { rows: returnRows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM vault_transactions
     WHERE client_id = $1 AND tx_type = 'out' AND is_return = true AND deleted_at IS NULL`,
    [client.id]
  );
  const inSum = num(inRows[0].s);
  const returnSum = num(returnRows[0].s);
  return Math.max(0, inSum - returnSum);
}

async function remaining(client) {
  const paid = await paidTotal(client);
  return Math.max(0, totalDue(client) - paid);
}

async function clientFinancials(client) {
  const paid = await paidTotal(client);
  return {
    centerIncome: centerIncome(client),
    bagAmount: bagAmount(client),
    total: totalDue(client),
    paid,
    remaining: Math.max(0, totalDue(client) - paid),
  };
}

module.exports = { paidTotal, remaining, clientFinancials };

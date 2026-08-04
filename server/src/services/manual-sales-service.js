// الفواتير اليدوية (مبيعات غير مرتبطة بعميل تدريبي) — LOGIC-2 §8.1
// الترقيم: next_manual_sales_invoice_no من الإعدادات مع حماية "أعلى رقم مستخدم + 1"
const { pool, withTransaction } = require('../db');
const { num } = require('../core-financial');

async function allocManualSaleInvoiceNo(dbClient) {
  await dbClient.query('SELECT * FROM app_settings WHERE id = 1 FOR UPDATE');
  const { rows: settingsRows } = await dbClient.query('SELECT next_manual_sales_invoice_no FROM app_settings WHERE id = 1');
  const { rows: maxRows } = await dbClient.query('SELECT COALESCE(MAX(invoice_no),0) AS m FROM manual_sales_invoices');
  const next = Math.max(settingsRows[0].next_manual_sales_invoice_no, maxRows[0].m + 1);
  await dbClient.query('UPDATE app_settings SET next_manual_sales_invoice_no = $1 WHERE id = 1', [next + 1]);
  return next;
}

async function listManualSales({ page = 1, pageSize = 20 }) {
  const offset = (page - 1) * pageSize;
  const { rows: countRows } = await pool.query('SELECT count(*) AS c FROM manual_sales_invoices');
  const total = parseInt(countRows[0].c, 10);
  const { rows } = await pool.query(
    `SELECT * FROM manual_sales_invoices ORDER BY sale_date DESC, created_at DESC LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );
  return { data: rows, page, pageSize, total };
}

// المبلغ شامل الضريبة (زي فواتير العملاء — فك تضمين عند الترحيل في accounting-service)
async function createManualSale({ customerName, saleDate, total }) {
  return withTransaction(async (dbClient) => {
    const invoiceNo = await allocManualSaleInvoiceNo(dbClient);
    const { rows } = await dbClient.query(
      `INSERT INTO manual_sales_invoices (invoice_no, sale_date, customer_name, total)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [invoiceNo, saleDate, customerName || null, num(total)]
    );
    return rows[0];
  });
}

module.exports = { listManualSales, createManualSale };

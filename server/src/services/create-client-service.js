// إنشاء عميل جديد — التحقق الأساسي فقط هنا؛ الترقيم الضريبي (assignInvoiceNumber) منفصل
// وبيتنفذ وقت طباعة الفاتورة فعلياً، مش وقت تسجيل العميل (زي منطق FTC2 الأصلي — LOGIC.md §6.1)
const { pool } = require('../db');
const { num } = require('../core-financial');

async function createClient(input) {
  const { rows } = await pool.query(
    `INSERT INTO clients
      (client_id, name, phone, nationality, client_type, company_id, credit_days,
       course_type, course_number, registration_date, expected_course_date,
       course_price, discount, bag_source, bag_price, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [input.client_id || null, input.name, input.phone || null, input.nationality || null,
     input.client_type || 'individual', input.company_id || null, input.credit_days || 0,
     input.course_type || null, input.course_number || null, input.registration_date,
     input.expected_course_date || null, num(input.course_price), num(input.discount),
     input.bag_source || null, num(input.bag_price), input.created_by || null]
  );
  return rows[0];
}

// ترقيم الفاتورة الرسمية — منقول من assignInvoiceNumber (LOGIC.md §6.1)
// الرقم لا يتغيّر أبداً بعد التخصيص لنفس العميل
async function assignInvoiceNumber(dbClient, clientRow) {
  if (clientRow.tax_invoice_no) return clientRow.tax_invoice_no;

  await dbClient.query('SELECT * FROM app_settings WHERE id = 1 FOR UPDATE');
  const { rows: settingsRows } = await dbClient.query('SELECT next_invoice_no FROM app_settings WHERE id = 1');
  const { rows: maxRows } = await dbClient.query('SELECT COALESCE(MAX(tax_invoice_no),0) AS m FROM clients');

  const nextFromSettings = settingsRows[0].next_invoice_no;
  const nextFromData = maxRows[0].m + 1;
  const invoiceNo = Math.max(nextFromSettings, nextFromData);

  await dbClient.query('UPDATE app_settings SET next_invoice_no = $1 WHERE id = 1', [invoiceNo + 1]);
  await dbClient.query('UPDATE clients SET tax_invoice_no = $1, tax_invoice_date = CURRENT_DATE WHERE id = $2',
    [invoiceNo, clientRow.id]);
  return invoiceNo;
}

module.exports = { createClient, assignInvoiceNumber };

// إنشاء المشتريات والموردين — راجع docs/LOGIC.md §12
// ⚠️ §12.1: سعر الوحدة في المشتريات "بدون ضريبة" صراحة — الضريبة إضافة فوق (مش فك تضمين)
const { pool, withTransaction } = require('../db');
const { num, vatOnNet } = require('../core-financial');

async function listSuppliers() {
  const { rows } = await pool.query('SELECT * FROM suppliers ORDER BY name');
  return rows;
}

// subtotal = مجموع (كمية × سعر الوحدة بدون ضريبة) — §12.1
// tax = subtotal × 15% (إضافة) — total = subtotal + tax
async function createPurchase({ supplierId, invoiceNo, purchaseDate, status = 'unpaid', items = [] }) {
  const prepared = items
    .map(i => ({ itemName: i.itemName, qty: num(i.qty), unitPrice: num(i.unitPrice) }))
    .filter(i => i.itemName && i.qty > 0);
  if (!prepared.length) throw new Error('لازم يكون فيه بنود على الأقل');

  const subtotal = prepared.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const tax = vatOnNet(subtotal);
  const total = subtotal + tax;

  return withTransaction(async (dbClient) => {
    const { rows: purchaseRows } = await dbClient.query(
      `INSERT INTO purchases (supplier_id, invoice_no, purchase_date, subtotal, tax_amount, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [supplierId || null, invoiceNo || null, purchaseDate, subtotal, tax, total, status]
    );
    const purchase = purchaseRows[0];

    for (const i of prepared) {
      await dbClient.query(
        `INSERT INTO purchase_items (purchase_id, item_name, qty, unit_price) VALUES ($1,$2,$3,$4)`,
        [purchase.id, i.itemName, i.qty, i.unitPrice]
      );
    }

    return { ...purchase, items: prepared, subtotal, tax, total };
  });
}

module.exports = { listSuppliers, createPurchase };

// دفتر تمويل مخزون الحقائب — منقول حرفياً من module-bags.js::recalcBagFundLedger
// راجع docs/LOGIC.md §3.2 قبل أي تعديل هنا — كل رقم في التعليقات مقصود، مش تقريبي
const { pool } = require('../db');
const { num } = require('../core-financial');

// دالة صرفة (pure): بتاخد مصفوفة سجلات مرتبة زمنياً + سعر الحقيبة الحالي،
// وترجع كل سجل بعد ما تحسب له qty/unitPrice/balanceBefore/balanceAfter + الرصيد النهائي وعدد الحقائب
function recalcBagFundLedger(entries, bagPrice) {
  const price = num(bagPrice) || 0;
  let bags = 0, balance = 0;
  const out = [];

  for (const raw of entries) {
    const entry = { ...raw };
    if (entry.status === 'pending') { out.push(entry); continue; } // مش داخل في أي إجمالي (§3.4)

    if (!entry.entry_type) {
      // سجل قديم بدون نوع: كمية ثابتة يدوياً، بدون أثر مالي
      bags += num(entry.qty);
      entry.balanceBefore = balance;
      entry.balanceAfter = balance;
      out.push(entry);
      continue;
    }

    entry.balanceBefore = balance;

    // manual_qty علم مستقل عن entry_type (ممكن يترافق مع deposit أو withdraw من فاتورة شراء حقيقية)
    if (entry.manual_qty) {
      const qtySigned = entry.entry_type === 'withdraw' ? -Math.abs(entry.manual_qty) : Math.abs(entry.manual_qty);
      entry.qty = qtySigned;
      entry.unit_price = entry.amount ? Math.round((num(entry.amount) / Math.abs(entry.manual_qty)) * 10000) / 10000 : price;
      bags += qtySigned;
      entry.balanceAfter = balance; // manualQty ما بيلمسش الرصيد التراكمي أبداً
      out.push(entry);
      continue;
    }

    if (entry.entry_type === 'withdraw') {
      const totalValue = bags * price + balance - num(entry.amount);
      const newBags = Math.floor(totalValue / price);
      entry.qty = newBags - bags;
      entry.unit_price = price;
      bags = newBags;
      balance = totalValue - newBags * price;
    } else if (entry.entry_type === 'issue') {
      entry.qty = -1;
      entry.unit_price = 0;
      bags -= 1;
      entry.balanceAfter = balance;
      out.push(entry);
      continue;
    } else {
      // إيداع عادي (deposit)
      const combined = balance + num(entry.amount);
      const addedBags = Math.floor(combined / price);
      entry.qty = addedBags;
      entry.unit_price = price;
      bags += addedBags;
      balance = combined - addedBags * price;
    }
    entry.balanceAfter = balance;
    out.push(entry);
  }

  return { ledger: out, finalBags: bags, finalBalance: Math.round(balance * 100) / 100 };
}

// نسخة متصلة بقاعدة البيانات: تجيب كل سجلات bag_stock مرتبة بـ created_at وتطبّق نفس المنطق
async function bagFundLedgerFromDb() {
  const { rows: settingsRows } = await pool.query('SELECT bag_price FROM app_settings WHERE id = 1');
  const bagPrice = num(settingsRows[0]?.bag_price);
  const { rows: entries } = await pool.query(
    `SELECT id, entry_type, entry_date, qty, manual_qty, amount, unit_price, status, created_at
     FROM bag_stock ORDER BY created_at ASC`
  );
  return recalcBagFundLedger(entries, bagPrice);
}

module.exports = { recalcBagFundLedger, bagFundLedgerFromDb };

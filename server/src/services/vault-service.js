// الخزينة: تخصيص الرقم التسلسلي الآمن + إنشاء حركة — راجع docs/LOGIC.md §2.1
const { pool, withTransaction } = require('../db');
const { num } = require('../core-financial');

const VALID_DESTS = ['vault', 'bank', 'network', 'other'];
const SEQ_COLUMN = {
  vault: 'next_vault_seq_vault', bank: 'next_vault_seq_bank',
  network: 'next_vault_seq_network', other: 'next_vault_seq_other',
};

// يخصّص أول رقم تسلسلي "حر" لوجهة معيّنة، مع حماية ضد التعارض (LOGIC.md §2.1، الخطوة 4)
// لازم يتنفذ جوه transaction (withTransaction) مع FOR UPDATE عشان يمنع Race Condition بين حركتين
// بيحصلوا في نفس اللحظة بالظبط.
async function allocVaultSeq(dbClient, destination) {
  const dest = VALID_DESTS.includes(destination) ? destination : 'vault';
  const col = SEQ_COLUMN[dest];

  await dbClient.query('SELECT * FROM app_settings WHERE id = 1 FOR UPDATE'); // قفل صف الإعدادات
  const { rows: settingsRows } = await dbClient.query(`SELECT ${col} AS next_seq FROM app_settings WHERE id = 1`);
  let candidate = settingsRows[0].next_seq;

  // خطوة حماية: لو الرقم ده مستخدم فعلاً (تعارض) دور على أول رقم فاضي فعلي
  let used = true;
  while (used) {
    const { rows } = await dbClient.query(
      `SELECT 1 FROM vault_transactions WHERE destination = $1 AND seq = $2 LIMIT 1`,
      [dest, candidate]
    );
    used = rows.length > 0;
    if (used) candidate += 1;
  }

  await dbClient.query(`UPDATE app_settings SET ${col} = $1 WHERE id = 1`, [candidate + 1]);
  return { destination: dest, seq: candidate };
}

async function createVaultTransaction(input) {
  return withTransaction(async (dbClient) => {
    const { seq, destination } = await allocVaultSeq(dbClient, input.destination);
    const { rows } = await dbClient.query(
      `INSERT INTO vault_transactions
        (seq, destination, tx_type, amount, tx_date, category, transaction_kind,
         client_id, company_transfer_id, is_return, settled, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [seq, destination, input.tx_type, num(input.amount), input.tx_date,
       input.category || null, input.transaction_kind || null,
       input.client_id || null, input.company_transfer_id || null,
       !!input.is_return, input.settled !== false, input.notes || null,
       input.created_by || null]
    );
    return rows[0];
  });
}

module.exports = { allocVaultSeq, createVaultTransaction };

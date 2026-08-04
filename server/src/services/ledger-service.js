// شجرة الحسابات + دفتر اليومية + القيود اليدوية — راجع docs/LOGIC-4.md §13
const { pool, withTransaction } = require('../db');
const { num } = require('../core-financial');

// رصيد كل حساب = صافي (مدين − دائن) عبر كل قيود اليومية — منطق ميزان المراجعة
async function listAccounts() {
  const { rows } = await pool.query(
    `SELECT a.id, a.code, a.name, a.account_type,
            COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
     FROM chart_of_accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id
     GROUP BY a.id, a.code, a.name, a.account_type
     ORDER BY a.code`
  );
  return rows.map(r => ({
    ...r,
    debit: num(r.debit),
    credit: num(r.credit),
    balance: num(r.debit) - num(r.credit), // موجب = مدين صافي، سالب = دائن صافي
  }));
}

// اليومية: كل قيد بأسطره وأسماء حساباته (مصدر القيود التلقائية واليدوية)
async function listJournalEntries({ page = 1, pageSize = 20 }) {
  const { rows: countRows } = await pool.query('SELECT count(*) AS c FROM journal_entries');
  const total = parseInt(countRows[0].c, 10);
  const offset = (page - 1) * pageSize;

  const { rows } = await pool.query(
    `SELECT je.id AS entry_id, je.entry_date, je.description, je.is_auto, je.entry_kind, je.created_at,
            jl.id AS line_id, jl.debit, jl.credit,
            a.code AS account_code, a.name AS account_name, a.account_type
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     JOIN chart_of_accounts a ON a.id = jl.account_id
     ORDER BY je.entry_date DESC, je.created_at DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );

  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.entry_id)) {
      grouped.set(r.entry_id, {
        id: r.entry_id, entryDate: r.entry_date, description: r.description,
        isAuto: r.is_auto, entryKind: r.entry_kind, createdAt: r.created_at, lines: [],
      });
    }
    grouped.get(r.entry_id).lines.push({
      accountCode: r.account_code, accountName: r.account_name, accountType: r.account_type,
      debit: num(r.debit), credit: num(r.credit),
    });
  }

  return { data: [...grouped.values()], page, pageSize, total };
}

// إنشاء قيد يدوي (LOGIC-4 §13.2 — قاعدة التوازن صارمة: فرق أقل من 0.01 فقط)
// lines: [{ accountCode, debit?, credit? }]
async function createManualEntry({ entryDate, description, entryKind = 'manual', lines = [], userId }) {
  if (!entryDate || !description) throw new Error('التاريخ والوصف مطلوبان');
  if (lines.length < 2) throw new Error('القيد لازم يكون فيه سطرين على الأقل');

  const prepared = [];
  for (const line of lines) {
    const debit = num(line.debit), credit = num(line.credit);
    if (debit > 0 && credit > 0) throw new Error('السطر الواحد لا يقبل مدين ودائن معاً');
    if (debit === 0 && credit === 0) continue;
    prepared.push({ accountCode: line.accountCode, debit, credit });
  }
  if (prepared.length < 2) throw new Error('القيد لازم يكون فيه سطرين على الأقل بقيم');

  return withTransaction(async (dbClient) => {
    // جلب ids الحسابات
    const codes = prepared.map(p => p.accountCode);
    const { rows: accountRows } = await dbClient.query(
      `SELECT id, code FROM chart_of_accounts WHERE code = ANY($1)`,
      [codes]
    );
    const idByCode = Object.fromEntries(accountRows.map(a => [a.code, a.id]));
    for (const p of prepared) {
      if (!idByCode[p.accountCode]) throw new Error(`الحساب ${p.accountCode} غير موجود في دليل الحسابات`);
    }

    const totalDebit = prepared.reduce((s, p) => s + p.debit, 0);
    const totalCredit = prepared.reduce((s, p) => s + p.credit, 0);
    if (Math.abs(totalDebit - totalCredit) >= 0.01) {
      throw new Error(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)}`);
    }

    const { rows: entryRows } = await dbClient.query(
      `INSERT INTO journal_entries (entry_date, description, is_auto, entry_kind, created_by)
       VALUES ($1, $2, false, $3, $4) RETURNING id`,
      [entryDate, description, entryKind, userId || null]
    );
    const entryId = entryRows[0].id;

    for (const p of prepared) {
      await dbClient.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,$3,$4)`,
        [entryId, idByCode[p.accountCode], p.debit, p.credit]
      );
    }

    await dbClient.query(
      `INSERT INTO audit_log (action, module, description, user_id) VALUES ('add', 'accounting', $1, $2)`,
      [`قيد يومية يدوي #${entryId}: ${description}`, userId || null]
    );

    return { id: entryId };
  });
}

module.exports = { listAccounts, listJournalEntries, createManualEntry };

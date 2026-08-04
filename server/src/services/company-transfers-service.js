// حوالات الشركات — راجع docs/LOGIC.md §4
// قيد خزينة واحد بكامل مبلغ الحوالة (LOGIC.md §2.4) + تخصيص على مجموعات فئات
// حوالة الشركة هي المصدر الرسمي دائماً لقيمة العميل المرتبط بيها (LOGIC.md §4.3)
const { pool, withTransaction } = require('../db');
const { num } = require('../core-financial');
const { allocVaultSeq } = require('./vault-service');

// إجمالي المخصص للحوالة = مجموع (سعر الدورة + سعر الحقيبة) × عدد المتدربين لكل مجموعة فئة
function transferAllocatedTotal(groups) {
  return groups.reduce((sum, g) => sum + (num(g.trainee_count) * (num(g.course_price) + num(g.bag_price))), 0);
}

// إنشاء حوالة شركة جديدة + مجموعاتها + قيد خزينة واحد بكامل المبلغ
async function createCompanyTransfer(input) {
  const groups = input.groups || [];
  const total = transferAllocatedTotal(groups);

  return withTransaction(async (dbClient) => {
    const { rows: transferRows } = await dbClient.query(
      `INSERT INTO company_transfers (company_id, transfer_date) VALUES ($1,$2) RETURNING *`,
      [input.company_id, input.transfer_date]
    );
    const transfer = transferRows[0];

    for (const g of groups) {
      await dbClient.query(
        `INSERT INTO company_transfer_groups (transfer_id, classification, trainee_count, course_price, bag_price)
         VALUES ($1,$2,$3,$4,$5)`,
        [transfer.id, g.classification, num(g.trainee_count), num(g.course_price), num(g.bag_price)]
      );
    }

    // قيد خزينة واحد بكامل المبلغ (LOGIC.md §2.4) — مش قيد منفصل لكل متدرب
    const { seq, destination } = await allocVaultSeq(dbClient, input.destination);
    const { rows: vaultRows } = await dbClient.query(
      `INSERT INTO vault_transactions
        (seq, destination, tx_type, amount, tx_date, category, transaction_kind,
         company_transfer_id, is_return, settled, notes, created_by)
       VALUES ($1,$2,'in',$3,$4,'company_transfer','company_transfer',$5,false,true,$6,$7)
       RETURNING *`,
      [seq, destination, total, input.transfer_date, transfer.id, input.notes || null, input.created_by || null]
    );

    await dbClient.query('UPDATE company_transfers SET vault_tx_id = $1 WHERE id = $2', [vaultRows[0].id, transfer.id]);

    return { ...transfer, vault_tx_id: vaultRows[0].id, groups, allocated_total: total };
  });
}

// ربط عملاء موجودين بالحوالة وتوزيع نصيب كل واحد حسب مجموعة تصنيفه (LOGIC.md §4.2 و §4.3)
// قيمة الحوالة هي المصدر الرسمي دائماً — بتكتب فوق course_price/bag_price/paid بتوع العميل
async function allocateClientsToTransfer(transferId, allocations) {
  // allocations: [{ client_id, classification, bag_source }]
  return withTransaction(async (dbClient) => {
    const { rows: groupRows } = await dbClient.query(
      `SELECT * FROM company_transfer_groups WHERE transfer_id = $1`, [transferId]
    );
    const groupsByClass = Object.fromEntries(groupRows.map(g => [g.classification, g]));

    const updated = [];
    for (const a of allocations) {
      const group = groupsByClass[a.classification];
      if (!group) throw new Error(`لا توجد مجموعة فئة باسم ${a.classification} في هذه الحوالة`);

      const bagAmount = a.bag_source === 'own' ? 0 : num(group.bag_price);
      const { rows } = await dbClient.query(
        `UPDATE clients SET
           company_transfer_id = $1, company_transfer_allocated = true,
           course_price = $2, bag_price = $3, bag_source = $4,
           paid = $2 + $3, paid2 = 0, updated_at = now()
         WHERE id = $5 RETURNING *`,
        [transferId, num(group.course_price), bagAmount, a.bag_source || null, a.client_id]
      );
      if (!rows.length) throw new Error(`العميل غير موجود: ${a.client_id}`);
      updated.push(rows[0]);
    }
    return updated;
  });
}

// إعادة مزامنة كل العملاء المرتبطين بحوالة معينة من قيم مجموعاتها (اتساق بعد أي تعديل على الحوالة)
async function syncClientsFromTransfer(transferId) {
  const { rows: groupRows } = await pool.query(
    `SELECT * FROM company_transfer_groups WHERE transfer_id = $1`, [transferId]
  );
  const groupsByClass = Object.fromEntries(groupRows.map(g => [g.classification, g]));

  const { rows: clientRows } = await pool.query(
    `SELECT * FROM clients WHERE company_transfer_id = $1 AND company_transfer_allocated = true`,
    [transferId]
  );

  const updated = [];
  for (const c of clientRows) {
    const group = groupsByClass[c.course_type] || groupRows[0];
    if (!group) continue;
    const bagAmount = c.bag_source === 'own' ? 0 : num(group.bag_price);
    const { rows } = await pool.query(
      `UPDATE clients SET course_price = $1, bag_price = $2, paid = $1 + $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [num(group.course_price), bagAmount, c.id]
    );
    updated.push(rows[0]);
  }
  return updated;
}

async function listCompanyTransfers({ page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query(
    `SELECT ct.*, c.name AS company_name,
       (SELECT COALESCE(SUM(trainee_count),0) FROM company_transfer_groups WHERE transfer_id = ct.id) AS trainee_count,
       (SELECT COALESCE(SUM(trainee_count*(course_price+bag_price)),0) FROM company_transfer_groups WHERE transfer_id = ct.id) AS allocated_total
     FROM company_transfers ct
     JOIN companies c ON c.id = ct.company_id
     ORDER BY ct.transfer_date DESC, ct.created_at DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );
  const { rows: countRows } = await pool.query('SELECT COUNT(*) AS c FROM company_transfers');
  return { data: rows, page, pageSize, total: parseInt(countRows[0].c, 10) };
}

async function getCompanyTransfer(id) {
  const { rows: transferRows } = await pool.query(
    `SELECT ct.*, c.name AS company_name FROM company_transfers ct
     JOIN companies c ON c.id = ct.company_id WHERE ct.id = $1`, [id]
  );
  if (!transferRows.length) return null;
  const { rows: groups } = await pool.query(
    `SELECT * FROM company_transfer_groups WHERE transfer_id = $1`, [id]
  );
  const { rows: clients } = await pool.query(
    `SELECT * FROM clients WHERE company_transfer_id = $1`, [id]
  );
  return { ...transferRows[0], groups, clients, allocated_total: transferAllocatedTotal(groups) };
}

module.exports = {
  transferAllocatedTotal, createCompanyTransfer, allocateClientsToTransfer,
  syncClientsFromTransfer, listCompanyTransfers, getCompanyTransfer,
};

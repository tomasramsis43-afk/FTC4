// الترحيل التلقائي لفاتورة الدورة إلى قيد يومية — منقول من module-accounting.js
// راجع docs/LOGIC.md §13.3 قبل أي تعديل. شرط الترحيل: 3 شروط لازم تتحقق كلها.
const { pool, withTransaction } = require('../db');
const { num, vatFromGross, netFromGross } = require('../core-financial');

const ACCOUNTS = { AR: '1100', REVENUE: '4000', VAT: '2100' };

async function accountId(client, code) {
  const { rows } = await client.query('SELECT id FROM chart_of_accounts WHERE code = $1', [code]);
  if (!rows.length) throw new Error(`الحساب ${code} غير موجود في دليل الحسابات`);
  return rows[0].id;
}

async function clientHasUnsettledCash(dbClient, clientId) {
  const { rows } = await dbClient.query(
    `SELECT 1 FROM vault_transactions WHERE client_id = $1 AND settled = false AND deleted_at IS NULL LIMIT 1`,
    [clientId]
  );
  return rows.length > 0;
}

// يرجّع سبب عدم الترحيل، أو null لو جاهز للترحيل (تشخيص — زي diagnoseUnpostedCourseInvoices في LOGIC.md §13.3)
async function diagnoseCourseInvoicePosting(dbClient, client) {
  if (client.course_invoice_de_id) return 'مُرحّلة بالفعل';
  if (!client.receipt_issue_date) return 'لا يوجد تاريخ إصدار فاتورة';
  if (!(num(client.receipt_actual_value) > 0)) return 'لا توجد قيمة فعلية من الإيصال';
  if (await clientHasUnsettledCash(dbClient, client.id)) return 'يوجد دفعة نقدية معلّقة غير مُسوّاة لهذا العميل';
  return null;
}

async function postCourseInvoice(clientRow) {
  return withTransaction(async (dbClient) => {
    const reason = await diagnoseCourseInvoicePosting(dbClient, clientRow);
    if (reason) {
      return { posted: false, reason };
    }

    const gross = num(clientRow.receipt_actual_value);
    const vat = vatFromGross(gross);
    const net = netFromGross(gross);

    const arId = await accountId(dbClient, ACCOUNTS.AR);
    const revId = await accountId(dbClient, ACCOUNTS.REVENUE);
    const vatId = await accountId(dbClient, ACCOUNTS.VAT);

    const { rows: entryRows } = await dbClient.query(
      `INSERT INTO journal_entries (entry_date, description, is_auto, entry_kind, source_client_id)
       VALUES ($1, $2, true, 'manual', $3) RETURNING id`,
      [clientRow.receipt_issue_date, `ترحيل تلقائي — فاتورة دورة: ${clientRow.name}`, clientRow.id]
    );
    const entryId = entryRows[0].id;

    await dbClient.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
      [entryId, arId, gross]
    );
    await dbClient.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
      [entryId, revId, net]
    );
    if (vat >= 0.004) { // عتبة تجاهل فروق التقريب (LOGIC.md §13.3-ب)
      await dbClient.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
        [entryId, vatId, vat]
      );
    } else {
      // لو الضريبة صفر تقريباً، لازم نعدّل سطر الإيراد ليساوي gross بالظبط عشان يفضل القيد متوازن
      await dbClient.query(`UPDATE journal_lines SET credit = $1 WHERE entry_id = $2 AND account_id = $3`, [gross, entryId, revId]);
    }

    await dbClient.query(`UPDATE clients SET course_invoice_de_id = $1 WHERE id = $2`, [entryId, clientRow.id]);

    return { posted: true, entryId, lines: { debitAR: gross, creditRevenue: net, creditVat: vat } };
  });
}

// ب) فاتورة شراء (LOGIC.md §13.3-أ) — ⚠️ subtotal بدون ضريبة صراحة، الضريبة إضافة مش فك تضمين (§12.1)
async function postPurchase(purchaseRow) {
  return withTransaction(async (dbClient) => {
    if (purchaseRow.linked_journal_entry_id) return { posted: false, reason: 'مُرحّلة بالفعل' };

    const expenseId = await accountId(dbClient, '5000');
    const vatId = await accountId(dbClient, ACCOUNTS.VAT);
    const cashId = await accountId(dbClient, '1000');
    const apId = await accountId(dbClient, '2000');

    const { rows: entryRows } = await dbClient.query(
      `INSERT INTO journal_entries (entry_date, description, is_auto, entry_kind, source_purchase_id)
       VALUES ($1, $2, true, 'manual', $3) RETURNING id`,
      [purchaseRow.purchase_date, `ترحيل تلقائي — فاتورة شراء #${purchaseRow.invoice_no || purchaseRow.id}`, purchaseRow.id]
    );
    const entryId = entryRows[0].id;

    await dbClient.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
      [entryId, expenseId, num(purchaseRow.subtotal)]);
    if (num(purchaseRow.tax_amount) >= 0.004) {
      await dbClient.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
        [entryId, vatId, num(purchaseRow.tax_amount)]);
    }
    const creditAccountId = purchaseRow.status === 'paid' ? cashId : apId;
    await dbClient.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
      [entryId, creditAccountId, num(purchaseRow.total)]);

    await dbClient.query(`UPDATE purchases SET linked_journal_entry_id = $1 WHERE id = $2`, [entryId, purchaseRow.id]);
    return { posted: true, entryId };
  });
}

// ج) فاتورة مبيعات يدوية (LOGIC.md §13.3-ب) — شاملة الضريبة زي فواتير العملاء، فك تضمين
async function postManualSale(saleRow) {
  return withTransaction(async (dbClient) => {
    if (saleRow.linked_journal_entry_id) return { posted: false, reason: 'مُرحّلة بالفعل' };

    const gross = num(saleRow.total);
    const vat = vatFromGross(gross);
    const net = netFromGross(gross);

    const arId = await accountId(dbClient, ACCOUNTS.AR);
    const revId = await accountId(dbClient, ACCOUNTS.REVENUE);
    const vatId = await accountId(dbClient, ACCOUNTS.VAT);

    const { rows: entryRows } = await dbClient.query(
      `INSERT INTO journal_entries (entry_date, description, is_auto, entry_kind, source_manual_sale_id)
       VALUES ($1, $2, true, 'manual', $3) RETURNING id`,
      [saleRow.sale_date, `ترحيل تلقائي — فاتورة مبيعات يدوية #${saleRow.invoice_no}`, saleRow.id]
    );
    const entryId = entryRows[0].id;

    await dbClient.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
      [entryId, arId, gross]);
    if (vat >= 0.004) {
      await dbClient.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
        [entryId, revId, net]);
      await dbClient.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
        [entryId, vatId, vat]);
    } else {
      await dbClient.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
        [entryId, revId, gross]);
    }

    await dbClient.query(`UPDATE manual_sales_invoices SET linked_journal_entry_id = $1 WHERE id = $2`, [entryId, saleRow.id]);
    return { posted: true, entryId };
  });
}

module.exports = { postCourseInvoice, diagnoseCourseInvoicePosting, postPurchase, postManualSale };

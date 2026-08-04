// التقارير المالية — منقولة من معادلات docs/LOGIC-2.md و docs/LOGIC-3.md حرفياً
// أي تعديل لازم يترافق بتحديث التوثيق. الأسماء هنا مطابقة لعناوين الأقسام في الـ docs.
const { pool } = require('../db');
const { num, vatFromGross, centerIncome, bagAmount, totalDue } = require('../core-financial');
const { bagFundLedgerFromDb } = require('./bagstock-service');

// ==================== أدوات مساعدة ====================

// رصيد كل وجهة خزينة حتى تاريخ معيّن (LOGIC-3 §9.1)
async function balancesUpTo(asOf) {
  const { rows } = await pool.query(
    `SELECT destination,
            COALESCE(SUM(amount) FILTER (WHERE tx_type='in'),0) -
            COALESCE(SUM(amount) FILTER (WHERE tx_type='out'),0) AS balance
     FROM vault_transactions WHERE deleted_at IS NULL AND tx_date <= $1
     GROUP BY destination`,
    [asOf]
  );
  const map = { vault: 0, bank: 0, network: 0, other: 0 };
  rows.forEach(r => { map[r.destination] = num(r.balance); });
  return map;
}

// المدفوع الفعلي لكل عميل حتى تاريخ معيّن (batch واحد) — LOGIC-2 §5
// نفس منطق paidTotal: الشركات المُرحّلة واللي ملهاش هوية بتثق في paid/paid2 المزامن
async function paidMapAsOf(clients, asOf) {
  const map = {};
  const withClientId = clients.filter(c => c.client_id && !c.company_transfer_allocated).map(c => c.id);
  if (withClientId.length) {
    const { rows } = await pool.query(
      `SELECT client_id,
              COALESCE(SUM(amount) FILTER (WHERE tx_type='in'),0) -
              COALESCE(SUM(amount) FILTER (WHERE tx_type='out' AND is_return=true),0) AS paid
       FROM vault_transactions
       WHERE deleted_at IS NULL AND tx_date <= $1 AND client_id = ANY($2)
       GROUP BY client_id`,
      [asOf, withClientId]
    );
    rows.forEach(r => { map[r.client_id] = Math.max(0, num(r.paid)); });
  }
  for (const c of clients) {
    if (!map[c.id]) {
      if (!c.client_id || c.company_transfer_allocated) map[c.id] = num(c.paid) + num(c.paid2);
      else map[c.id] = 0;
    }
  }
  return map;
}

// أثر قيد يدوي على قائمة الدخل: مصروف (+) / إيراد (−) — LOGIC-2 §7.4
function incomeImpact(rows) {
  let total = 0;
  for (const r of rows) {
    if (r.account_type === 'expense') total += num(r.debit) - num(r.credit);
    else if (r.account_type === 'revenue') total += num(r.credit) - num(r.debit);
  }
  return total;
}

// ==================== قائمة الدخل (LOGIC-2 §7) ====================

async function incomeStatement({ from, to }) {
  const { rows: clients } = await pool.query(
    `SELECT * FROM clients WHERE cancelled = false AND registration_date BETWEEN $1 AND $2`,
    [from, to]
  );

  // §7.1 — توزيع الإيرادات حسب نوع الدورة (centerIncome فقط، الحقيبة أمانة مش إيراد)
  const revenueBreakdown = {};
  for (const c of clients) {
    const key = c.course_type || '—';
    revenueBreakdown[key] = num(revenueBreakdown[key]) + centerIncome(c);
  }

  // §7.2 — مردودات المبيعات (مع استبعاد مردودات العملاء الملغيين لتفادي الخصم المزدوج)
  const { rows: returnsRows } = await pool.query(
    `SELECT COALESCE(SUM(vt.amount),0) AS total
     FROM vault_transactions vt
     LEFT JOIN clients c ON c.id = vt.client_id
     WHERE vt.deleted_at IS NULL AND vt.tx_type='out' AND vt.is_return=true
       AND vt.tx_date BETWEEN $1 AND $2
       AND (c.id IS NULL OR c.cancelled = false)`,
    [from, to]
  );
  const salesReturnsTotal = num(returnsRows[0].total);

  // §7.3 — المصروفات التشغيلية (مجمعة حسب التصنيف، مع الاستثناءات الأربعة)
  const { rows: expenseRows } = await pool.query(
    `SELECT COALESCE(category, '—') AS category, COALESCE(SUM(amount),0) AS total
     FROM vault_transactions
     WHERE deleted_at IS NULL AND tx_type='out' AND tx_date BETWEEN $1 AND $2
       AND is_return = false
       AND bag_stock_ref IS NULL
       AND (transaction_kind IS NULL OR transaction_kind = 'operational')
     GROUP BY category ORDER BY total DESC`,
    [from, to]
  );
  const expenseBreakdown = expenseRows.map(r => ({ category: r.category, total: num(r.total) }));

  // §7.4 — قيود يدوية: إهلاك + مصروف مستحق + تسويات
  const { rows: manualRows } = await pool.query(
    `SELECT je.entry_kind, a.account_type,
            COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     JOIN chart_of_accounts a ON a.id = jl.account_id
     WHERE je.entry_date BETWEEN $1 AND $2
       AND je.entry_kind IN ('depreciation','accrued','adjustment')
     GROUP BY je.entry_kind, a.account_type`,
    [from, to]
  );
  const byKind = {};
  manualRows.forEach(r => { (byKind[r.entry_kind] = byKind[r.entry_kind] || []).push(r); });
  const dep = incomeImpact(byKind.depreciation || []);
  const acc = incomeImpact(byKind.accrued || []);
  const rj = incomeImpact(byKind.adjustment || []);

  const grossRevenue = Object.values(revenueBreakdown).reduce((s, v) => s + v, 0);
  const netRevenue = grossRevenue - salesReturnsTotal;
  const totalExpenseBase = expenseBreakdown.reduce((s, e) => s + e.total, 0);
  const totalExpense = totalExpenseBase + dep + acc;
  const netIncome = netRevenue - totalExpense + rj;

  return {
    from, to,
    revenueBreakdown,
    grossRevenue,
    salesReturnsTotal,
    netRevenue,
    expenseBreakdown,
    totalExpenseBase,
    depreciation: dep,
    accrued: acc,
    adjustments: rj,
    totalExpense,
    netIncome,
  };
}

// ==================== الميزانية العمومية (LOGIC-3 §9) ====================

async function balanceSheet({ asOf }) {
  const balances = await balancesUpTo(asOf);

  // §9.1 — الأصول الثابتة الصافية من قيود يدوية (1500 أصول ثابتة − 1590 مجمع الإهلاك)
  const { rows: faRows } = await pool.query(
    `SELECT a.code, COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
     FROM journal_lines jl JOIN chart_of_accounts a ON a.id = jl.account_id
     WHERE a.code IN ('1500','1590')
     GROUP BY a.code`
  );
  const faMap = Object.fromEntries(faRows.map(r => [r.code, num(r.debit) - num(r.credit)]));
  const fixedAssetsNet = (faMap['1500'] || 0) + (faMap['1590'] || 0);

  // §9.2 — التزام أمانة الحقائب (أهم بند)
  const { rows: bagCustodyRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN bag_source='own' THEN 0 ELSE bag_price END),0) AS bagCollected,
       COUNT(*) FILTER (WHERE bag_source='stock') AS stockIssued,
       COALESCE(SUM(bag_price) FILTER (WHERE bag_source='buy' AND bag_status='purchased'),0) AS spentDirect
     FROM clients WHERE cancelled = false AND suspended = false AND registration_date <= $1`,
    [asOf]
  );
  const { rows: settingsRows } = await pool.query('SELECT bag_price FROM app_settings WHERE id = 1');
  const bagPrice = num(settingsRows[0]?.bag_price);

  const bagCollected = num(bagCustodyRows[0].bagCollected);
  const stockIssued = parseInt(bagCustodyRows[0].stockIssued, 10) || 0;
  const spentDirect = num(bagCustodyRows[0].spentDirect);
  const bagCustody = bagCollected - (stockIssued * bagPrice + spentDirect);
  const bagCustodyLiability = Math.max(0, bagCustody); // التزام على المركز (أمانة لسه ما اتسلمتش)
  const bagCustodyAsset = bagCustody < 0 ? -bagCustody : 0; // نادر: اتسلّم أكتر مما اتحصّل

  // §9.4 — الذمم المدينة حتى asOf
  const { rows: clientRows } = await pool.query(
    `SELECT * FROM clients WHERE cancelled = false AND suspended = false AND registration_date <= $1`,
    [asOf]
  );
  const paidMap = await paidMapAsOf(clientRows, asOf);
  let receivables = 0;
  for (const c of clientRows) receivables += Math.max(0, totalDue(c) - (paidMap[c.id] || 0));

  // مخزون الحقائب المتبقي (من دفتر التمويل المُعاد حسابه من الصفر) × سعر الحقيبة الحالي
  const ledger = await bagFundLedgerFromDb();
  const bagInventory = ledger.finalBags * bagPrice;

  // §9.5 — القروض (بالتصنيف الصريح transaction_kind بدل تحليل النص — قرار SCHEMA.md)
  const { rows: loanRows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE transaction_kind='loan_in'),0) -
       COALESCE(SUM(amount) FILTER (WHERE transaction_kind='loan_out'),0) AS loans
     FROM vault_transactions WHERE deleted_at IS NULL AND tx_date <= $1`,
    [asOf]
  );
  const loans = num(loanRows[0].loans);

  // مصروفات مستحقة + التزامات أخرى (من قيود يدوية على حسابات خصوم)
  const { rows: liabRows } = await pool.query(
    `SELECT je.entry_kind,
            COALESCE(SUM(jl.credit),0) - COALESCE(SUM(jl.debit),0) AS balance
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     WHERE je.entry_kind IN ('accrued','other_liability')
     GROUP BY je.entry_kind`
  );
  const liabMap = Object.fromEntries(liabRows.map(r => [r.entry_kind, Math.max(0, num(r.balance))]));
  const accrued = liabMap.accrued || 0;
  const otherLiab = liabMap.other_liability || 0;

  // الأرباح المرحّلة (رصيد حساب 3100) — رأس المال = حقوق الملكية − الأرباح المرحّلة (§9.3)
  const { rows: reRows } = await pool.query(
    `SELECT COALESCE(SUM(jl.credit),0) - COALESCE(SUM(jl.debit),0) AS balance
     FROM journal_lines jl JOIN chart_of_accounts a ON a.id = jl.account_id
     WHERE a.code = '3100'`
  );
  const retainedEarnings = num(reRows[0].balance);

  const totalAssets =
    balances.vault + balances.bank + balances.network + receivables + bagInventory
    + Math.max(0, fixedAssetsNet) + bagCustodyAsset;

  const totalLiabilities = bagCustodyLiability + Math.max(0, loans) + accrued + otherLiab;

  const totalEquity = totalAssets - totalLiabilities;
  const ownerCapital = totalEquity - retainedEarnings;

  return {
    asOf,
    cash: balances.vault, bank: balances.bank, network: balances.network,
    receivables, bagInventory, fixedAssetsNet,
    bagCustody, bagCustodyLiability, bagCustodyAsset,
    loans, accrued, otherLiab,
    retainedEarnings, ownerCapital,
    totalAssets, totalLiabilities, totalEquity,
  };
}

// ==================== قائمة التدفقات النقدية (LOGIC-3 §10) ====================

const FINANCIAL_KINDS = ['partner_drawing', 'loan_in', 'loan_out', 'capital'];

function isFinancialOut(t) {
  return FINANCIAL_KINDS.includes(t.transaction_kind)
    || /مسحوبات|شركاء|قرض|رأس\s*مال/.test(t.category || '');
}
function isInvestmentOut(t) {
  return t.transaction_kind === 'fixed_asset'
    || /أصل|أصول/.test(t.category || '');
}

async function cashFlow({ from, to }) {
  const { rows } = await pool.query(
    `SELECT * FROM vault_transactions
     WHERE deleted_at IS NULL AND destination <> 'other' AND tx_date BETWEEN $1 AND $2
     ORDER BY tx_date, seq`,
    [from, to]
  );

  let opIn = 0, opOut = 0, opReturns = 0, finIn = 0, finOut = 0, invOut = 0;
  for (const t of rows) {
    if (t.tx_type === 'in') {
      if (!t.settled) continue; // حركة واردة غير مُسوّاة لا تُحسب (LOGIC-3 §10)
      if (t.client_id || t.company_transfer_id) opIn += num(t.amount);
      else finIn += num(t.amount);
    } else {
      if (t.is_return) opReturns += num(t.amount);
      else if (isFinancialOut(t)) finOut += num(t.amount);
      else if (isInvestmentOut(t)) invOut += num(t.amount);
      else opOut += num(t.amount);
    }
  }

  const dayBeforeFrom = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
  const begin = await balancesUpTo(dayBeforeFrom);
  const end = await balancesUpTo(to);
  const beginCash = begin.vault + begin.bank + begin.network;
  const endCash = end.vault + end.bank + end.network;

  const netOperating = opIn - opReturns - opOut;
  const netInvesting = -invOut;
  const netFinancing = finIn - finOut;
  const netChange = netOperating + netInvesting + netFinancing;
  const expected = beginCash + netChange;

  return {
    from, to,
    operating: { in: opIn, returns: opReturns, out: opOut, net: netOperating },
    investing: { out: invOut, net: netInvesting },
    financing: { in: finIn, out: finOut, net: netFinancing },
    netChange,
    beginCash, endCash, expected,
    reconciled: Math.abs(expected - endCash) < 0.01,
  };
}

// ==================== أعمار الذمم (LOGIC-3 §11) ====================

function agingBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

function daysDiff(fromDate, toDate) {
  return Math.floor((new Date(toDate) - new Date(fromDate)) / 86400000);
}

async function arAging({ asOf }) {
  const { rows } = await pool.query(
    `SELECT * FROM clients WHERE cancelled = false AND suspended = false AND registration_date <= $1`,
    [asOf]
  );
  const paidMap = await paidMapAsOf(rows, asOf);
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const clients = [];

  for (const c of rows) {
    const remaining = Math.max(0, totalDue(c) - (paidMap[c.id] || 0));
    if (remaining <= 0) continue;
    // §11.2 — شركة بأجل ائتماني: استحقاق = التسجيل + الأيام؛ غير كده مستحق فوراً
    const isCompanyCredit = c.client_type === 'company' && num(c.credit_days) > 0;
    const dueDate = isCompanyCredit
      ? new Date(new Date(c.registration_date).getTime() + num(c.credit_days) * 86400000).toISOString().slice(0, 10)
      : c.registration_date;
    const days = daysDiff(dueDate, asOf);
    const bucket = agingBucket(Math.max(0, days));
    buckets[bucket] = num(buckets[bucket]) + remaining;
    clients.push({ id: c.id, name: c.name, remaining, days: Math.max(0, days), bucket });
  }

  return { asOf, buckets, clients };
}

async function apAging({ asOf }) {
  const { rows } = await pool.query(
    `SELECT p.*, s.name AS supplier_name
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.status = 'unpaid' AND p.purchase_date <= $1`,
    [asOf]
  );
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const invoices = rows.map(p => {
    const days = daysDiff(p.purchase_date, asOf);
    const bucket = agingBucket(Math.max(0, days));
    buckets[bucket] = num(buckets[bucket]) + num(p.total);
    return { id: p.id, invoiceNo: p.invoice_no, supplierName: p.supplier_name, total: num(p.total), days: Math.max(0, days), bucket };
  });
  return { asOf, buckets, invoices };
}

// ==================== إقرار ضريبة القيمة المضافة (LOGIC-2 §8.2) ====================

async function vatReturn({ from, to }) {
  // صفوف المبيعات من مصدرين: فواتير الدورات + الفواتير اليدوية (§8.1)
  const { rows: courseSales } = await pool.query(
    `SELECT name, receipt_issue_date AS sale_date, receipt_actual_value AS gross
     FROM clients
     WHERE cancelled = false AND receipt_actual_value > 0 AND receipt_issue_date BETWEEN $1 AND $2`,
    [from, to]
  );
  const { rows: manualSales } = await pool.query(
    `SELECT customer_name, sale_date, total AS gross FROM manual_sales_invoices WHERE sale_date BETWEEN $1 AND $2`,
    [from, to]
  );
  const { rows: returnRows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS gross FROM vault_transactions
     WHERE deleted_at IS NULL AND tx_type='out' AND is_return=true AND tx_date BETWEEN $1 AND $2`,
    [from, to]
  );

  const salesGross = courseSales.reduce((s, r) => s + num(r.gross), 0)
    + manualSales.reduce((s, r) => s + num(r.gross), 0);
  const outputVatGross = [...courseSales, ...manualSales].reduce((s, r) => s + vatFromGross(r.gross), 0);

  const returnsGross = num(returnRows[0].gross);
  const returnsVat = vatFromGross(returnsGross);

  const outputVat = outputVatGross - returnsVat;
  const salesNet = (salesGross - outputVatGross) - (returnsGross - returnsVat);

  const { rows: purchaseRows } = await pool.query(
    `SELECT COALESCE(SUM(total),0) AS gross, COALESCE(SUM(tax_amount),0) AS input_vat
     FROM purchases WHERE purchase_date BETWEEN $1 AND $2`,
    [from, to]
  );
  const purchasesGross = num(purchaseRows[0].gross);
  const inputVat = num(purchaseRows[0].input_vat);
  const purchasesNet = purchasesGross - inputVat;

  const netVat = outputVat - inputVat;

  return {
    from, to,
    sales: { gross: salesGross, outputVatGross, salesNet },
    returns: { gross: returnsGross, vat: returnsVat },
    outputVat,
    purchases: { gross: purchasesGross, inputVat, purchasesNet },
    netVat,
  };
}

// ==================== ميزان المراجعة (LOGIC-4 §13.4) ====================

async function trialBalance({ asOf } = {}) {
  const params = [];
  let dateFilter = '';
  if (asOf) {
    params.push(asOf);
    dateFilter = 'WHERE je.entry_date <= $1';
  }
  const { rows } = await pool.query(
    `SELECT a.code, a.name, a.account_type,
            COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
     FROM chart_of_accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id
     LEFT JOIN journal_entries je ON je.id = jl.entry_id
     ${dateFilter}
     GROUP BY a.code, a.name, a.account_type
     ORDER BY a.code`,
    params
  );
  const accounts = rows.map(r => ({
    code: r.code, name: r.name, accountType: r.account_type,
    debit: num(r.debit), credit: num(r.credit),
    balance: num(r.debit) - num(r.credit), // موجب = مدين صافي، سالب = دائن صافي
  }));
  const totalDebit = accounts.reduce((s, a) => s + a.debit, 0);
  const totalCredit = accounts.reduce((s, a) => s + a.credit, 0);
  return {
    asOf: asOf || null,
    accounts,
    totalDebit: Math.round(totalDebit * 100) / 100,
    totalCredit: Math.round(totalCredit * 100) / 100,
    balanced: Math.abs(totalDebit - totalCredit) < 0.01,
  };
}

// ==================== الزكاة التقديرية (LOGIC-2 §8.3) ====================

async function zakat({ year }) {
  const asOf = `${year}-12-31`;
  const sheet = await balanceSheet({ asOf });

  // الإضافات/الخصومات اليدوية والمعدّل من جدول الزكاة (سنة الميزانية)
  const { rows: adjRows } = await pool.query(
    `SELECT additions, deductions, rate FROM zakat_adjustments WHERE year = $1`,
    [year]
  );
  const adj = adjRows[0] || { additions: 0, deductions: 0, rate: 0.025 };

  // القروض طويلة الأجل: صافي القروض الموجب فقط
  const longTermLoans = Math.max(0, sheet.loans);
  const fixedAssets = Math.max(0, sheet.fixedAssetsNet);

  const base = Math.max(0, sheet.totalEquity) + longTermLoans - fixedAssets
    + num(adj.additions) - num(adj.deductions);
  const zakatBase = Math.max(0, base);
  const zakatDue = zakatBase * num(adj.rate);

  return {
    year, asOf,
    equity: sheet.totalEquity,
    longTermLoans,
    fixedAssetsNet: fixedAssets,
    manualAdditions: num(adj.additions),
    manualDeductions: num(adj.deductions),
    rate: num(adj.rate),
    zakatBase,
    zakatDue: Math.round(zakatDue * 100) / 100,
  };
}

module.exports = {
  incomeStatement, balanceSheet, cashFlow, arAging, apAging, vatReturn,
  trialBalance, zakat,
};

require('dotenv').config();
const express = require('express');
const { pool } = require('./db');
const { clientFinancials } = require('./services/clients-service');
const { bagFundLedgerFromDb } = require('./services/bagstock-service');
const { postCourseInvoice, postPurchase, postManualSale } = require('./services/accounting-service');
const { listClients } = require('./services/list-clients-service');
const { createVaultTransaction } = require('./services/vault-service');
const { createClient } = require('./services/create-client-service');
const { withTransaction } = require('./db');
const { assignInvoiceNumber } = require('./services/create-client-service');

const app = express();
app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// مثال حي يثبت إن المعادلات (LOGIC.md) شغالة فعلياً فوق السكيمة الجديدة (SCHEMA.md)
// بيرجع العميل + كل أرصدته المحسوبة (centerIncome, bagAmount, total, paid, remaining)
app.get('/api/clients/:id/financials', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'العميل غير موجود' });
    const financials = await clientFinancials(rows[0]);
    res.json({ client: rows[0], financials });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// دفتر تمويل مخزون الحقائب الكامل — راجع docs/LOGIC.md §3.2
app.get('/api/bagstock/ledger', async (req, res) => {
  try {
    const result = await bagFundLedgerFromDb();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// الترحيل التلقائي لفاتورة دورة عميل — راجع docs/LOGIC.md §13.3
app.post('/api/clients/:id/post-invoice', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'العميل غير موجود' });
    const result = await postCourseInvoice(rows[0]);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// إنشاء عميل جديد
app.post('/api/clients', async (req, res) => {
  try {
    const client = await createClient(req.body);
    res.status(201).json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تخصيص رقم فاتورة رسمي لعميل (لا يتكرر أبداً — UNIQUE على مستوى القاعدة)
app.post('/api/clients/:id/assign-invoice-number', async (req, res) => {
  try {
    const result = await withTransaction(async (dbClient) => {
      const { rows } = await dbClient.query('SELECT * FROM clients WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rows.length) throw new Error('العميل غير موجود');
      const invoiceNo = await assignInvoiceNumber(dbClient, rows[0]);
      return { invoiceNo };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// حركة خزينة جديدة (بترقيم تسلسلي آمن لكل وجهة — LOGIC.md §2.1)
app.post('/api/vault-transactions', async (req, res) => {
  try {
    const tx = await createVaultTransaction(req.body);
    res.status(201).json(tx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// سجل العملاء (قراءة + فلاتر + أرصدة محسوبة) — أساس شاشة العملاء
app.get('/api/clients', async (req, res) => {
  try {
    const result = await listClients({
      search: req.query.search,
      clientType: req.query.type,
      hasBalance: req.query.hasBalance === 'true',
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ترحيل فاتورة شراء
app.post('/api/purchases/:id/post', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    res.json(await postPurchase(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ترحيل فاتورة مبيعات يدوية
app.post('/api/manual-sales/:id/post', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM manual_sales_invoices WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    res.json(await postManualSale(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FTC4 server running on port ${PORT}`));

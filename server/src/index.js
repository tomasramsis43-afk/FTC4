require('dotenv').config();
const express = require('express');
const { pool } = require('./db');
const { clientFinancials } = require('./services/clients-service');
const { bagFundLedgerFromDb } = require('./services/bagstock-service');
const { postCourseInvoice } = require('./services/accounting-service');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FTC4 server running on port ${PORT}`));

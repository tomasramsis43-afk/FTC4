require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, withTransaction } = require('./db');
const { clientFinancials } = require('./services/clients-service');
const { bagFundLedgerFromDb } = require('./services/bagstock-service');
const { postCourseInvoice, postPurchase, postManualSale } = require('./services/accounting-service');
const { createVaultTransaction } = require('./services/vault-service');
const { createClient, assignInvoiceNumber } = require('./services/create-client-service');
const { listClients } = require('./services/list-clients-service');
const { listVaultTransactions } = require('./services/list-vault-service');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'frontend'))); // يخدم index.html, i18n/*.json, app.js

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

app.get('/api/bagstock/ledger', async (req, res) => {
  try {
    res.json(await bagFundLedgerFromDb());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/:id/post-invoice', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'العميل غير موجود' });
    res.json(await postCourseInvoice(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    res.status(201).json(await createClient(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/clients/:id/assign-invoice-number', async (req, res) => {
  try {
    const result = await withTransaction(async (dbClient) => {
      const { rows } = await dbClient.query('SELECT * FROM clients WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rows.length) throw new Error('العميل غير موجود');
      return { invoiceNo: await assignInvoiceNumber(dbClient, rows[0]) };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vault-transactions', async (req, res) => {
  try {
    res.status(201).json(await createVaultTransaction(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vault-transactions', async (req, res) => {
  try {
    const result = await listVaultTransactions({
      destination: req.query.destination,
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 30,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchases/:id/post', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    res.json(await postPurchase(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

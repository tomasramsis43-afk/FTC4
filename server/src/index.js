require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const { pool, withTransaction } = require('./db');
const { clientFinancials } = require('./services/clients-service');
const { bagFundLedgerFromDb, createBagStockEntry } = require('./services/bagstock-service');
const { postCourseInvoice, postPurchase, postManualSale } = require('./services/accounting-service');
const { createVaultTransaction, deleteVaultTransaction } = require('./services/vault-service');
const { createClient, assignInvoiceNumber } = require('./services/create-client-service');
const { listClients } = require('./services/list-clients-service');
const { listVaultTransactions } = require('./services/list-vault-service');
const { listInvoices } = require('./services/list-invoices-service');
const { listPurchases } = require('./services/list-purchases-service');
const {
  createCompanyTransfer, allocateClientsToTransfer, syncClientsFromTransfer,
  listCompanyTransfers, getCompanyTransfer,
} = require('./services/company-transfers-service');
const {
  login, me, requireAuth, requireAdmin, changePassword,
  listUsers, createUser, updateUser,
} = require('./services/auth-service');
const {
  incomeStatement, balanceSheet, cashFlow, arAging, apAging, vatReturn,
  trialBalance, zakat,
} = require('./services/reports-service');
const { listAccounts, listJournalEntries, createManualEntry } = require('./services/ledger-service');
const { listSuppliers, createPurchase } = require('./services/purchases-write-service');
const { listManualSales, createManualSale } = require('./services/manual-sales-service');
const { getSettings, updateSettings } = require('./services/settings-service');

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

app.post('/api/auth/login', async (req, res) => {
  try {
    const result = await login({
      username: req.body.username,
      password: req.body.password,
      ipAddress: req.ip,
      deviceInfo: req.headers['user-agent'],
    });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// كل مسارات /api بعد دي محمية — لازم توكن Bearer صالح
app.use('/api', requireAuth);

app.get('/api/auth/me', async (req, res) => {
  try {
    res.json(await me(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ إدارة المستخدمين (admin فقط) ============
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    res.json(await listUsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    res.status(201).json(await createUser(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    res.json(await updateUser(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/change-password', requireAdmin, async (req, res) => {
  try {
    res.json(await changePassword(req.user.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ التقارير المالية ============
function reportDate(value, fallback) {
  return value || fallback;
}

app.get('/api/reports/income-statement', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startOfYear = `${new Date().getFullYear()}-01-01`;
    res.json(await incomeStatement({
      from: reportDate(req.query.from, startOfYear),
      to: reportDate(req.query.to, today),
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/balance-sheet', async (req, res) => {
  try {
    res.json(await balanceSheet({ asOf: reportDate(req.query.asOf, new Date().toISOString().slice(0, 10)) }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/cash-flow', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startOfYear = `${new Date().getFullYear()}-01-01`;
    res.json(await cashFlow({
      from: reportDate(req.query.from, startOfYear),
      to: reportDate(req.query.to, today),
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/ar-aging', async (req, res) => {
  try {
    res.json(await arAging({ asOf: reportDate(req.query.asOf, new Date().toISOString().slice(0, 10)) }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/ap-aging', async (req, res) => {
  try {
    res.json(await apAging({ asOf: reportDate(req.query.asOf, new Date().toISOString().slice(0, 10)) }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/vat', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startOfYear = `${new Date().getFullYear()}-01-01`;
    res.json(await vatReturn({
      from: reportDate(req.query.from, startOfYear),
      to: reportDate(req.query.to, today),
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/trial-balance', async (req, res) => {
  try {
    res.json(await trialBalance({ asOf: req.query.asOf || null }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/zakat', async (req, res) => {
  try {
    res.json(await zakat({ year: parseInt(req.query.year, 10) || new Date().getFullYear() }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ شجرة الحسابات واليومية ============
app.get('/api/accounts', async (req, res) => {
  try {
    res.json(await listAccounts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});app.get('/api/journal', async (req, res) => {
  try {
    res.json(await listJournalEntries({
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/journal', requireAdmin, async (req, res) => {
  try {
    res.status(201).json(await createManualEntry({
      entryDate: req.body.entryDate,
      description: req.body.description,
      entryKind: req.body.entryKind,
      lines: req.body.lines,
      userId: req.user.id,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
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

app.post('/api/bagstock', async (req, res) => {
  try {
    res.status(201).json(await createBagStockEntry(req.body));
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

// حذف منطقي لحركة خزينة (LOGIC.md §2.2) — ممنوع حذف فعلي أبداً
app.delete('/api/vault-transactions/:id', async (req, res) => {
  try {
    res.json(await deleteVaultTransaction(req.params.id, {
      userId: req.user.id,
      reason: req.body?.reason || null,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/invoices', async (req, res) => {
  try {
    const result = await listInvoices({
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20,
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

app.get('/api/purchases', async (req, res) => {
  try {
    res.json(await listPurchases({
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suppliers', async (req, res) => {
  try {
    res.json(await listSuppliers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchases', async (req, res) => {
  try {
    res.status(201).json(await createPurchase(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/manual-sales', async (req, res) => {
  try {
    res.json(await listManualSales({
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/manual-sales', async (req, res) => {
  try {
    res.status(201).json(await createManualSale(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
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

app.get('/api/companies', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM companies ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/company-transfers', async (req, res) => {
  try {
    res.status(201).json(await createCompanyTransfer(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/company-transfers', async (req, res) => {
  try {
    res.json(await listCompanyTransfers({
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/company-transfers/:id', async (req, res) => {
  try {
    const transfer = await getCompanyTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'الحوالة غير موجودة' });
    res.json(transfer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/company-transfers/:id/allocate-clients', async (req, res) => {
  try {
    res.json(await allocateClientsToTransfer(req.params.id, req.body.allocations || []));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/company-transfers/:id/resync', async (req, res) => {
  try {
    res.json(await syncClientsFromTransfer(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ الإعدادات ============
app.get('/api/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    res.json(await updateSettings(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FTC4 server running on port ${PORT}`));

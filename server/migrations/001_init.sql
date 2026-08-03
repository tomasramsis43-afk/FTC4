-- FTC4 — Migration 001: السكيمة الأساسية الكاملة
-- مرجع: docs/LOGIC.md (أجزاء 1-4) و docs/SCHEMA.md
-- ينفَّذ مرة واحدة على قاعدة بيانات فاضية (Neon/Postgres 14+)

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- عشان gen_random_uuid()

-- ============ 1. المستخدمون ============
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','reception')),
  active BOOLEAN NOT NULL DEFAULT true,
  tfa_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  device_info TEXT,
  ip_address TEXT,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 2. الشركات وحوالاتها ============
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  tax_number TEXT,
  default_credit_days INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE company_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  transfer_date DATE NOT NULL,
  vault_tx_id UUID, -- يُربط لاحقاً بعد إنشاء vault_transactions (ALTER أسفل)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE company_transfer_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES company_transfers(id) ON DELETE CASCADE,
  classification TEXT NOT NULL,
  trainee_count INT NOT NULL DEFAULT 0,
  course_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  bag_price NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- ============ 3. العملاء ============
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  nationality TEXT,
  client_type TEXT NOT NULL DEFAULT 'individual' CHECK (client_type IN ('individual','company')),
  company_id UUID REFERENCES companies(id),
  client_tax_number TEXT,
  credit_days INT DEFAULT 0,

  course_type TEXT,
  course_number TEXT,
  registration_date DATE NOT NULL,
  expected_course_date DATE,
  actual_course_date DATE,

  course_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid2 NUMERIC(12,2) NOT NULL DEFAULT 0,

  bag_source TEXT CHECK (bag_source IN ('own','stock','buy')),
  bag_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  bag_status TEXT,

  company_transfer_id UUID REFERENCES company_transfers(id),
  company_transfer_allocated BOOLEAN NOT NULL DEFAULT false,

  tax_invoice_no INT UNIQUE,
  tax_invoice_date DATE,

  invoice_legacy TEXT,
  receipt_issue_date DATE,
  receipt_actual_value NUMERIC(12,2),
  course_invoice_de_id UUID, -- يُربط لاحقاً بـ journal_entries

  suspended BOOLEAN NOT NULL DEFAULT false,
  cancelled BOOLEAN NOT NULL DEFAULT false,

  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clients_client_id ON clients(client_id);
CREATE INDEX idx_clients_company_transfer ON clients(company_transfer_id);
CREATE INDEX idx_clients_registration_date ON clients(registration_date);
CREATE INDEX idx_clients_cancelled_suspended ON clients(cancelled, suspended);

CREATE TABLE deleted_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id),
  client_name_snapshot TEXT,
  invoice_no INT NOT NULL,
  invoice_date DATE,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID REFERENCES users(id),
  deleted_reason TEXT
);

-- ============ 4. الخزينة ============
CREATE TABLE vault_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq INT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('vault','bank','network','other')),
  tx_type TEXT NOT NULL CHECK (tx_type IN ('in','out')),
  amount NUMERIC(12,2) NOT NULL,
  tx_date DATE NOT NULL,
  category TEXT,
  transaction_kind TEXT CHECK (transaction_kind IN
    ('operational','loan_in','loan_out','partner_drawing','capital','fixed_asset')),

  client_id UUID REFERENCES clients(id),
  auto_client_id UUID REFERENCES clients(id),
  company_transfer_id UUID REFERENCES company_transfers(id),
  bag_stock_ref UUID, -- يُربط لاحقاً بـ bag_stock

  is_return BOOLEAN NOT NULL DEFAULT false,
  settled BOOLEAN NOT NULL DEFAULT true,

  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id),
  deleted_reason TEXT
);
CREATE UNIQUE INDEX idx_vault_seq_per_dest ON vault_transactions(destination, seq) WHERE deleted_at IS NULL;
CREATE INDEX idx_vault_client ON vault_transactions(client_id);
CREATE INDEX idx_vault_date ON vault_transactions(tx_date);
CREATE INDEX idx_vault_company_transfer ON vault_transactions(company_transfer_id);

ALTER TABLE company_transfers ADD CONSTRAINT fk_company_transfer_vault_tx
  FOREIGN KEY (vault_tx_id) REFERENCES vault_transactions(id);

CREATE TABLE scheduled_vault_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template JSONB NOT NULL,
  recurrence_rule TEXT,
  next_run_date DATE,
  active BOOLEAN NOT NULL DEFAULT true
);

-- ============ 5. مخزون الحقائب ============
CREATE TABLE bag_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type TEXT CHECK (entry_type IN ('manualQty','withdraw','issue')),
  entry_date DATE NOT NULL,
  qty NUMERIC(12,2),
  amount NUMERIC(12,2),
  unit_price NUMERIC(12,2),
  client_id UUID REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bagstock_date ON bag_stock(entry_date);

ALTER TABLE vault_transactions ADD CONSTRAINT fk_vault_bag_stock_ref
  FOREIGN KEY (bag_stock_ref) REFERENCES bag_stock(id);

-- ============ 6. المشتريات والموردين ============
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  tax_number TEXT
);

CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID REFERENCES suppliers(id),
  invoice_no TEXT,
  purchase_date DATE NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid','unpaid')),
  attachment_url TEXT,
  linked_journal_entry_id UUID, -- يُربط لاحقاً
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  qty NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- ============ 7. الفواتير اليدوية ============
CREATE TABLE manual_sales_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no INT UNIQUE,
  sale_date DATE NOT NULL,
  customer_name TEXT,
  total NUMERIC(12,2) NOT NULL,
  linked_journal_entry_id UUID, -- يُربط لاحقاً
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 8. القيد المزدوج الموحّد ============
CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense'))
);

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date DATE NOT NULL,
  description TEXT NOT NULL,
  is_auto BOOLEAN NOT NULL DEFAULT false,
  entry_kind TEXT NOT NULL DEFAULT 'manual' CHECK (entry_kind IN
    ('manual','depreciation','accrued','fixed_asset','other_liability','adjustment')),

  source_purchase_id UUID REFERENCES purchases(id),
  source_manual_sale_id UUID REFERENCES manual_sales_invoices(id),
  source_client_id UUID REFERENCES clients(id),

  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  debit NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit NUMERIC(12,2) NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);

ALTER TABLE purchases ADD CONSTRAINT fk_purchase_journal_entry
  FOREIGN KEY (linked_journal_entry_id) REFERENCES journal_entries(id);
ALTER TABLE manual_sales_invoices ADD CONSTRAINT fk_manualsale_journal_entry
  FOREIGN KEY (linked_journal_entry_id) REFERENCES journal_entries(id);
ALTER TABLE clients ADD CONSTRAINT fk_client_course_invoice_de
  FOREIGN KEY (course_invoice_de_id) REFERENCES journal_entries(id);

-- ⚠️ فرض توازن القيد (مجموع مدين = مجموع دائن) على مستوى القاعدة نفسها
CREATE OR REPLACE FUNCTION check_journal_entry_balanced() RETURNS TRIGGER AS $$
DECLARE
  total_debit NUMERIC(14,2);
  total_credit NUMERIC(14,2);
  target_entry UUID;
BEGIN
  target_entry := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO total_debit, total_credit
    FROM journal_lines WHERE entry_id = target_entry;
  IF ABS(total_debit - total_credit) >= 0.01 THEN
    RAISE EXCEPTION 'القيد % غير متوازن: مدين % ≠ دائن %', target_entry, total_debit, total_credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry_balanced();
  -- DEFERRABLE عشان نقدر ندخل كل سطور القيد جوه transaction واحدة قبل ما يتفحص التوازن

-- ============ 9. الزكاة والإعدادات ============
CREATE TABLE zakat_adjustments (
  year INT PRIMARY KEY,
  additions NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  rate NUMERIC(5,4) NOT NULL DEFAULT 0.025,
  notes TEXT
);

CREATE TABLE app_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_invoice_no INT NOT NULL DEFAULT 1,
  next_manual_sales_invoice_no INT NOT NULL DEFAULT 1,
  next_return_invoice_no INT NOT NULL DEFAULT 1,
  next_voucher_no INT NOT NULL DEFAULT 1,
  next_vault_seq_vault INT NOT NULL DEFAULT 1,
  next_vault_seq_bank INT NOT NULL DEFAULT 1,
  next_vault_seq_network INT NOT NULL DEFAULT 1,
  next_vault_seq_other INT NOT NULL DEFAULT 1,
  vault_locked_through DATE,
  bag_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  center_name TEXT,
  center_tax_number TEXT,
  center_phone TEXT,
  center_logo_url TEXT,
  default_ui_language TEXT NOT NULL DEFAULT 'ar' CHECK (default_ui_language IN ('ar','en'))
);
INSERT INTO app_settings (id) VALUES (1);

-- ============ 10. سجل التدقيق ============
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL CHECK (action IN ('add','edit','delete')),
  module TEXT NOT NULL,
  description TEXT NOT NULL,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_date ON audit_log(created_at);

-- ============ 11. دليل الحسابات الافتراضي (seed) ============
INSERT INTO chart_of_accounts (code, name, account_type) VALUES
  ('1000','النقدية والبنوك','asset'),
  ('1100','حسابات مدينة (ذمم العملاء)','asset'),
  ('1200','مخزون الحقائب التدريبية','asset'),
  ('1500','الأصول الثابتة','asset'),
  ('1590','مجمع الإهلاك','asset'),
  ('1900','حساب تسويات معلّق','asset'),
  ('2000','حسابات دائنة (ذمم الموردين)','liability'),
  ('2100','ضريبة القيمة المضافة المستحقة','liability'),
  ('2200','مصروفات مستحقة','liability'),
  ('2300','قروض','liability'),
  ('3000','رأس المال','equity'),
  ('3100','الأرباح المرحّلة','equity'),
  ('4000','إيرادات الدورات التدريبية','revenue'),
  ('4100','إيرادات أخرى','revenue'),
  ('5000','مصروفات تشغيلية','expense'),
  ('5100','مصروف الإهلاك','expense'),
  ('5200','تكلفة الحقائب التدريبية','expense');

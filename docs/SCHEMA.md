# FTC4 — تصميم سكيمة قاعدة البيانات المقترحة

> مبنية مباشرة على المعادلات الموثّقة في `docs/LOGIC.md` (الأجزاء 1-4).
> الفرق الجوهري عن FTC2: كل كيان هنا **جدول علائقي حقيقي** بدل `kv_store` (JSON blob واحد بيتكتب بالكامل في كل حفظ).
> كل جدول فيه تعليق (`--`) بيربطه بالمعادلة/القسم المتعلق بيه في LOGIC.md.

---

## 0. قرارات تصميم عامة قبل السكيمة

1. **PostgreSQL** (نفس المحرك الحالي، Neon) — بس هنستخدم جداول حقيقية بدل `kv_store`
2. **حذف منطقي (Soft Delete) في كل الجداول المالية** — عمود `deleted_at` / `deleted_by` / `deleted_reason` بدل حذف فعلي (قسم 2.2)، **بدون استثناء**
3. **الترقيم الرسمي (فواتير/سندات) بقيد فريد على مستوى قاعدة البيانات** (`UNIQUE`) مش بس منطق JavaScript — تحسين عن FTC2 (نقطة الهشاشة #3 في الجزء 4)
4. **توحيد نظام القيد اليومي**: FTC2 فيه نظامين منفصلين ومتوازيين (`journal` للقيود اليدوية البسيطة زي الإهلاك، و`journalDE` للقيد المزدوج الكامل) — **في FTC4 هيتوحّدوا في نظام واحد** (`journal_entries` + `journal_lines`) كل القيود من غير استثناء بتعدّي من نفس المسار
5. **تصنيف صريح بدل تحليل النص**: عمود `transaction_kind` صريح بدل البحث عن كلمة "قرض" في الملاحظات (نقطة الهشاشة #1، الجزء 4) — **محتاج تأكيدك النهائي**
6. **ثنائية اللغة**: أعمدة النظام (تسميات، تصنيفات) بتتخزن كمفاتيح ترجمة (`revenue_category_key` مثلاً) مش نص عربي مباشر؛ بيانات المستخدم (اسم عميل، ملاحظات) بتتخزن `TEXT` عادي زي ما اتكتبت

---

## 1. المستخدمون والصلاحيات

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','reception')),
  active BOOLEAN NOT NULL DEFAULT true,
  tfa_secret TEXT,                      -- إعداد المصادقة الثنائية
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  device_info TEXT,
  ip_address TEXT,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 2. العملاء والشركات (قسم 5، 6.1-6.3)

```sql
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  tax_number TEXT,
  default_credit_days INT DEFAULT 0,     -- الأجل الائتماني الافتراضي (قسم 11.2)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE company_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  transfer_date DATE NOT NULL,
  vault_tx_id UUID,                      -- القيد الموحد الوحيد في الخزينة (قسم 2.4)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- مجموعات تقسيم الحوالة حسب الفئة (قسم 4.2) — كل مجموعة سعر/تصنيف/عدد منفصل
CREATE TABLE company_transfer_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES company_transfers(id) ON DELETE CASCADE,
  classification TEXT NOT NULL,          -- مثال: "سعودي" / "مقيم"
  trainee_count INT NOT NULL DEFAULT 0,
  course_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  bag_price NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT,                        -- رقم الهوية/الإقامة (مش PK — ممكن يتكرر لعملاء مختلفين نادراً)
  name TEXT NOT NULL,
  phone TEXT,
  nationality TEXT,
  client_type TEXT NOT NULL DEFAULT 'individual' CHECK (client_type IN ('individual','company')),
  company_id UUID REFERENCES companies(id),
  client_tax_number TEXT,
  credit_days INT DEFAULT 0,

  -- بيانات الدورة
  course_type TEXT,
  course_number TEXT,
  registration_date DATE NOT NULL,
  expected_course_date DATE,
  actual_course_date DATE,

  -- الماليات الأساسية (قسم 5)
  course_price NUMERIC(12,2) NOT NULL DEFAULT 0,   -- شامل الضريبة
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid NUMERIC(12,2) NOT NULL DEFAULT 0,           -- دفعة تسجيل يدوية 1
  paid2 NUMERIC(12,2) NOT NULL DEFAULT 0,          -- دفعة تسجيل يدوية 2

  -- الحقيبة (نموذج الأمانة — قسم 3)
  bag_source TEXT CHECK (bag_source IN ('own','stock','buy')),
  bag_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  bag_status TEXT,                        -- 'purchased' إلخ

  -- حوالة شركة
  company_transfer_id UUID REFERENCES company_transfers(id),
  company_transfer_allocated BOOLEAN NOT NULL DEFAULT false,  -- قسم 5 — يغيّر مصدر paidTotal

  -- الفاتورة الضريبية (قسم 6.1)
  tax_invoice_no INT UNIQUE,              -- ⚠️ UNIQUE على مستوى القاعدة، مش بس منطق JS
  tax_invoice_date DATE,

  -- فاتورة الدورة / الإيصال (قسم 13.3 الترحيل التلقائي)
  invoice_legacy TEXT,                    -- رقم فاتورة النظام القديم (حقل تاريخي، للعرض فقط)
  receipt_issue_date DATE,
  receipt_actual_value NUMERIC(12,2),
  course_invoice_de_id UUID,              -- FK لـ journal_entries بعد الترحيل التلقائي

  suspended BOOLEAN NOT NULL DEFAULT false,   -- قيد الاعتماد (قسم 3.4، ونفس المبدأ هنا)
  cancelled BOOLEAN NOT NULL DEFAULT false,

  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clients_client_id ON clients(client_id);
CREATE INDEX idx_clients_company_transfer ON clients(company_transfer_id);
CREATE INDEX idx_clients_registration_date ON clients(registration_date);

-- الفواتير المحذوفة منطقياً (قسم 6.2)
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
```

---

## 3. الخزينة (قسم 2)

```sql
CREATE TABLE vault_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq INT NOT NULL,                       -- تسلسلي مستقل *لكل* destination (قسم 2.1)
  destination TEXT NOT NULL CHECK (destination IN ('vault','bank','network','other')),
  tx_type TEXT NOT NULL CHECK (tx_type IN ('in','out')),
  amount NUMERIC(12,2) NOT NULL,
  tx_date DATE NOT NULL,
  category TEXT,
  transaction_kind TEXT CHECK (transaction_kind IN
    ('operational','loan_in','loan_out','partner_drawing','capital','fixed_asset', NULL)),
    -- ⚠️ صريح بدل تحليل النص — بديل isLoanTx()/isFinancingCat()/isInvestingCat() (نقطة هشاشة #1، الجزء 4)

  client_id UUID REFERENCES clients(id),           -- ممكن NULL لو حركة عامة
  auto_client_id UUID REFERENCES clients(id),       -- دفعة تسجيل تلقائية مرتبطة بعميل
  company_transfer_id UUID REFERENCES company_transfers(id),
  bag_stock_ref UUID,                               -- FK لـ bag_stock لو الحركة تمويل حقائب

  is_return BOOLEAN NOT NULL DEFAULT false,
  settled BOOLEAN NOT NULL DEFAULT true,            -- false = دفعة استقبال معلّقة لحد اعتماد الأدمن (قسم 13.3)

  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id),
  deleted_reason TEXT
);
CREATE UNIQUE INDEX idx_vault_seq_per_dest ON vault_transactions(destination, seq) WHERE deleted_at IS NULL;
  -- ⚠️ الرقم التسلسلي فريد لكل وجهة على مستوى القاعدة، ومينفعش يتكرر حتى لو الحركة محذوفة منطقياً
  -- (لازم منطق التطبيق يتأكد من عدم إعادة استخدام أرقام السجلات المحذوفة أيضاً، مش بس الفعّالة)
CREATE INDEX idx_vault_client ON vault_transactions(client_id);
CREATE INDEX idx_vault_date ON vault_transactions(tx_date);

-- الحركات المجدولة/المتكررة (اشتراكات، إيجار شهري...)
CREATE TABLE scheduled_vault_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template JSONB NOT NULL,                -- نفس شكل vault_transactions بدون seq/id
  recurrence_rule TEXT,                   -- 'monthly' إلخ
  next_run_date DATE,
  active BOOLEAN NOT NULL DEFAULT true
);
```

---

## 4. مخزون الحقائب (قسم 3)

```sql
CREATE TABLE bag_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type TEXT CHECK (entry_type IN ('manualQty','withdraw','issue', NULL)),  -- NULL = سجل قديم بكمية ثابتة
  entry_date DATE NOT NULL,
  qty NUMERIC(12,2),
  amount NUMERIC(12,2),                    -- المبلغ المرتبط (لو إيداع/شراء)
  unit_price NUMERIC(12,2),                -- محسوبة وقت الإدخال (manualQty) أو من سعر الإعدادات وقتها
  client_id UUID REFERENCES clients(id),   -- لو النوع 'issue' (تسليم لعميل)
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved')),  -- قسم 3.4
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bagstock_date ON bag_stock(entry_date);
-- ⚠️ recalcBagFundLedger() (قسم 3.2) لازم يفضل يشتغل بنفس منطق "إعادة الحساب من الصفر بالترتيب"
-- حتى مع جدول علائقي — الرصيد مش عمود مخزَّن، بل محسوب دايماً من التاريخ الكامل مرتب بالتاريخ
```

---

## 5. المشتريات والموردين (قسم 12)

```sql
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
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,   -- بدون ضريبة (قسم 12.1 — عكس فواتير العملاء!)
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,  -- = subtotal × 15% (إضافة، مش فك تضمين)
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid','unpaid')),
  attachment_url TEXT,
  linked_journal_entry_id UUID,             -- FK بعد الترحيل التلقائي (قسم 13.3-أ)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  qty NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0   -- ⚠️ بدون ضريبة صراحة — لازم يبقى واضح في الفورم
);
```

---

## 6. الفواتير اليدوية (المبيعات غير المرتبطة بعميل تدريبي) — قسم 8.1

```sql
CREATE TABLE manual_sales_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no INT UNIQUE,
  sale_date DATE NOT NULL,
  customer_name TEXT,
  total NUMERIC(12,2) NOT NULL,             -- شامل الضريبة (زي فواتير العملاء، مش زي المشتريات)
  linked_journal_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 7. القيد المزدوج الموحّد (قسم 13) — **نظام واحد بدل الاثنين في FTC2**

```sql
CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense'))
  -- accountNormalBalance(type) = (asset|expense) → مدين، غير كده → دائن  (قسم 13.1)
);

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date DATE NOT NULL,
  description TEXT NOT NULL,
  is_auto BOOLEAN NOT NULL DEFAULT false,
  entry_kind TEXT CHECK (entry_kind IN
    ('manual','depreciation','accrued','fixed_asset','other_liability','adjustment', NULL)),
    -- ⚠️ يوحّد القيود اليدوية الخاصة (كانت في journal منفصل في FTC2) مع القيد المزدوج العادي

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
  CHECK (NOT (debit > 0 AND credit > 0))   -- سطر واحد ميكونش مدين ودائن مع بعض (قسم 13.4)
);
-- ⚠️ توازن القيد (مجموع مدين = مجموع دائن، قسم 13.2) لازم يتفرض بـ trigger على مستوى القاعدة
-- مش بس فحص JavaScript وقت الحفظ، عشان نضمن سلامة البيانات حتى لو دخل تعديل مباشر
```

---

## 8. الزكاة والإعدادات

```sql
CREATE TABLE zakat_adjustments (
  year INT PRIMARY KEY,
  additions NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  rate NUMERIC(5,4) NOT NULL DEFAULT 0.025,
  notes TEXT
);

-- بدل settings كـ blob واحد في kv_store: صف واحد بأعمدة صريحة
CREATE TABLE app_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- صف وحيد دايماً
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
```

---

## 9. سجل التدقيق (Audit Log)

```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL CHECK (action IN ('add','edit','delete')),
  module TEXT NOT NULL,
  description TEXT NOT NULL,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_date ON audit_log(created_at);
```

---

## ملاحظات تنفيذية مهمة قبل ما نكتب أي كود فعلي

1. **الأرصدة (balances) مش أعمدة مخزَّنة أبداً** — دايماً محسوبة `SUM()` من الحركات، زي ما هو معمول في FTC2 (`balanceOf`, `recalcBagFundLedger`). ده أبطأ شوية من عمود مخزَّن، لكنه أضمن (زي ما ناقشنا في مشكلة أداء `saveClients()` قبل كده) — للأداء، ممكن نضيف **materialized view** أو جدول cache منفصل يتحدّث بعد كل حركة، مش نستبدل مصدر الحقيقة.
2. **الفهارس المقترحة فوق تقريبية** — هتتظبط بعد ما نشوف الاستعلامات الفعلية الأكتر استخداماً.
3. **RLS (Row-Level Security)** في Postgres ممكن يفيد جداً هنا لفرض عزل بيانات الاستقبال (مشكلة كانت موجودة في FTC2 واتصلحت على مستوى الفرونت إند بس) — يستاهل نفكر فيه كطبقة حماية إضافية على مستوى القاعدة نفسها.

---

**جاهز تراجع السكيمة دي وتقولي رأيك، خصوصاً في:**
1. توحيد نظام القيد اليومي (قسم 7) — موافق؟
2. `transaction_kind` الصريح بدل تحليل النص (قسم 3) — موافق؟
3. أي جدول ناقص حسب خبرتك بالنظام الحالي مش موثّق في LOGIC.md؟

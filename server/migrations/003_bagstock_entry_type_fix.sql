-- FTC4 — Migration 003: تصحيح ثاني مكتشَف من الاختبار المحلي
-- المشكلة: entry_type كان بقيم خاطئة (manualQty كانت مكتوبة كـ "نوع" بدل ما تكون علَم مستقل).
-- الصح (راجع module-bags.js الأصلي، LOGIC.md §3.2): entry_type = NULL (سجل قديم) | 'deposit' | 'withdraw' | 'issue'
-- و manual_qty عمود مستقل ممكن يترافق مع أي نوع (غالباً deposit أو withdraw من فاتورة شراء حقيقية).

ALTER TABLE bag_stock DROP CONSTRAINT bag_stock_entry_type_check;
ALTER TABLE bag_stock ADD CONSTRAINT bag_stock_entry_type_check
  CHECK (entry_type IN ('deposit','withdraw','issue'));

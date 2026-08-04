-- FTC4 — Migration 002: تصحيح مكتشَف من الاختبار المحلي
-- المشكلة: عمود qty الواحد كان بيتلخبط بين "الكمية المُدخلة يدوياً" (manualQty، قبل الحساب)
-- و"الكمية الناتجة" (بعد تطبيق recalcBagFundLedger). لازم عمود منفصل — راجع LOGIC.md §3.2.

ALTER TABLE bag_stock ADD COLUMN manual_qty NUMERIC(12,2);
COMMENT ON COLUMN bag_stock.manual_qty IS
  'الكمية الفعلية المُدخلة يدوياً من المستخدم (مثلاً من فاتورة شراء حقيقية) عند entry_type=''manualQty''. '
  'عمود qty بيفضل NULL وقت الإدخال ويتحسب لاحقاً من recalcBagFundLedger (قد يساوي manual_qty بالسالب لو سحب).';

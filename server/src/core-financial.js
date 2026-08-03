// معادلات مالية أساسية — منقولة حرفياً من منطق FTC2 (راجع docs/LOGIC.md الجزء 1 و2)
// أي تعديل هنا لازم يترافق بتحديث LOGIC.md ومراجعة من tomasramsis

const VAT_RATE = 0.15;

// قراءة أرقام آمنة: يدعم الأرقام العربية-الهندية والفارسية وفواصل الآلاف (LOGIC.md §1.1)
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v)
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)) // عربي-هندي
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0)) // فارسي
    .replace(/\u066B/g, '.')   // فاصلة عشرية عربية
    .replace(/[\u066C,]/g, ''); // فواصل الآلاف
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function fmt(n) {
  return num(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// فك تضمين الضريبة من مبلغ شامل (فواتير العملاء — LOGIC.md §1.3)
function vatFromGross(g) {
  const gross = num(g);
  return gross - (gross / (1 + VAT_RATE));
}
function netFromGross(g) {
  return num(g) / (1 + VAT_RATE);
}

// إضافة الضريبة فوق مبلغ صافي (المشتريات — LOGIC.md §12.1 — ⚠️ عكس الاتجاه فوق تماماً)
function vatOnNet(subtotal) {
  return num(subtotal) * VAT_RATE;
}

// المعادلات المالية الأساسية للعميل (LOGIC.md §5)
// bagAmount/centerIncome/total بياخدوا صف عميل بنفس أسماء أعمدة جدول clients
function bagAmount(client) {
  return client.bag_source === 'own' ? 0 : num(client.bag_price);
}
function centerIncome(client) {
  return num(client.course_price) - num(client.discount);
}
function totalDue(client) {
  return centerIncome(client) + bagAmount(client);
}

// paidTotal لازم يستعلم قاعدة البيانات (حركات الخزينة المرتبطة بالعميل) — ده service مش دالة صرفة،
// موجود في clients-service.js. هنا بس الدوال الحسابية الصرفة (pure functions) القابلة لإعادة الاستخدام.

module.exports = {
  VAT_RATE, num, fmt, vatFromGross, netFromGross, vatOnNet,
  bagAmount, centerIncome, totalDue,
};

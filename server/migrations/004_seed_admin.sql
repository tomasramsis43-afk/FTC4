-- FTC4 — Migration 004: المستخدم admin الافتراضي
-- المستخدم: admin | كلمة المرور المؤقتة: admin123 (يُفضّل تغييرها فوراً)
-- ON CONFLICT يمنع تكرار الإنشاء لو الاتنفذت قبل كده

INSERT INTO users (username, password_hash, full_name, role)
SELECT 'admin', '$2a$10$l21OOHNlUJATpDpcx/pAm.Jk5ujVGzv2mWQsV11SOBU8PvClMigXm', 'Administrator', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin');

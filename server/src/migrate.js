// يشغّل كل ملفات migrations/*.sql بالترتيب الأبجدي (001_, 002_...)
// وبعدها: لو مفيش مستخدم admin، بيولّد باسورد عشوائي قوي وينشئه —
// الباسورد ده بيتطبع في الـ console مرة واحدة بس، ومش بيتسجل في أي ملف أو git.
// استخدام: DATABASE_URL=... JWT_SECRET=... node src/migrate.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function seedAdminIfMissing() {
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE username = 'admin'`);
  if (rows.length) { console.log('ℹ️  مستخدم admin موجود بالفعل — تخطي الإنشاء'); return; }

  const password = crypto.randomBytes(9).toString('base64url'); // باسورد عشوائي 12 حرف تقريباً
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES ('admin',$1,'Administrator','admin')`,
    [hash]
  );
  console.log('\n' + '='.repeat(60));
  console.log('🔑 تم إنشاء مستخدم admin بباسورد عشوائي (اُطبع هنا مرة واحدة فقط):');
  console.log(`   اسم المستخدم: admin`);
  console.log(`   كلمة المرور:  ${password}`);
  console.log('   احفظها الآن في مكان آمن — لن تُطبع مرة أخرى.');
  console.log('='.repeat(60) + '\n');
}

async function run() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`⏳ تنفيذ ${file}...`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
    console.log(`✅ تم ${file}`);
  }
  await seedAdminIfMissing();
  await pool.end();
  console.log('🎉 كل الـ migrations اتنفذت بنجاح');
}

run().catch(err => {
  console.error('❌ فشل الترحيل:', err.message);
  process.exit(1);
});

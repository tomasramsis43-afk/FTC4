// يشغّل كل ملفات migrations/*.sql بالترتيب الأبجدي (001_, 002_...)
// استخدام: DATABASE_URL=... node src/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function run() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`⏳ تنفيذ ${file}...`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
    console.log(`✅ تم ${file}`);
  }
  await pool.end();
  console.log('🎉 كل الـ migrations اتنفذت بنجاح');
}

run().catch(err => {
  console.error('❌ فشل الترحيل:', err.message);
  process.exit(1);
});

// إعدادات المركز (صف وحيد id=1 في app_settings) — docs/SCHEMA.md قسم 8
const { pool } = require('../db');

// القيم المسموح تعديلها من الواجهة (قراءة كل الصف للعرض)
const EDITABLE = [
  'center_name', 'center_tax_number', 'center_phone', 'center_logo_url',
  'bag_price', 'default_ui_language', 'vault_locked_through',
];

async function getSettings() {
  const { rows } = await pool.query('SELECT * FROM app_settings WHERE id = 1');
  return rows[0];
}

async function updateSettings(fields = {}) {
  const sets = [];
  const params = [];
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      params.push(fields[key] === '' ? null : fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (params.length) {
    await pool.query(
      `UPDATE app_settings SET ${sets.join(', ')} WHERE id = 1`,
      params
    );
  }
  return getSettings();
}

module.exports = { getSettings, updateSettings };

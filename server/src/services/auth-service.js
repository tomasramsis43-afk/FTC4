// خدمة المصادقة وإدارة المستخدمين — login بـ bcrypt + JWT
// الأدوار: admin (إدارة كاملة) / reception (قراءة وإدخال بيانات)
// راجع docs/SCHEMA.md قسم 1 (users, login_history) وقرارات الصلاحيات
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

function requireSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me') {
    throw new Error('JWT_SECRET لازم يتضبط في .env (قيمة سرية قوية، مش change-me)');
  }
  return process.env.JWT_SECRET;
}

function signToken(user) {
  return jwt.sign({ userId: user.id, role: user.role }, requireSecret(), {
    expiresIn: process.env.JWT_EXPIRY || '8h',
  });
}

const PUBLIC_USER = 'id, username, full_name, role, active, created_at';

async function login({ username, password, ipAddress, deviceInfo }) {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, full_name, role, active FROM users WHERE username = $1`,
    [username]
  );
  const user = rows[0];
  if (!user || !user.active) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة');

  const token = signToken(user);

  await pool.query(
    `INSERT INTO login_history (user_id, device_info, ip_address) VALUES ($1, $2, $3)`,
    [user.id, deviceInfo || null, ipAddress || null]
  );

  return {
    token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
  };
}

async function me(userId) {
  const { rows } = await pool.query(`SELECT ${PUBLIC_USER} FROM users WHERE id = $1 AND active = true`, [userId]);
  if (!rows.length) throw new Error('المستخدم غير موجود أو غير نشط');
  return rows[0];
}

// middleware: يشترط توكن صالح — يعلّق req.user = { id, role }
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مصرح — سجل الدخول أولاً' });
  try {
    const payload = jwt.verify(token, requireSecret());
    req.user = { id: payload.userId, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'جلسة منتهية أو توكن غير صالح — سجل الدخول مجدداً' });
  }
}

// middleware: يشترط دور admin
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'هذه العملية للأدمن فقط' });
  next();
}

async function changePassword(userId, { currentPassword, newPassword }) {
  if (!newPassword || newPassword.length < 6) throw new Error('كلمة المرور الجديدة لازم تكون 6 أحرف على الأقل');
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
  if (!rows.length) throw new Error('المستخدم غير موجود');
  const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!ok) throw new Error('كلمة المرور الحالية غير صحيحة');
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  return { ok: true };
}

// ============ إدارة المستخدمين (admin فقط) ============

async function listUsers() {
  const { rows } = await pool.query(`SELECT ${PUBLIC_USER} FROM users ORDER BY created_at DESC`);
  return rows;
}

async function createUser({ username, password, fullName, role }) {
  const uname = (username || '').trim().toLowerCase();
  if (!uname) throw new Error('اسم المستخدم مطلوب');
  if (!password || password.length < 6) throw new Error('كلمة المرور لازم تكون 6 أحرف على الأقل');
  if (!['admin', 'reception'].includes(role)) throw new Error('دور غير صالح — admin أو reception');
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_USER}`,
      [uname, hash, fullName || null, role]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new Error('اسم المستخدم موجود بالفعل');
    throw err;
  }
}

async function updateUser(id, { password, fullName, role, active }) {
  const user = await me(id);
  const updates = [];
  const params = [];
  const push = (col, val) => { params.push(val); updates.push(`${col} = $${params.length}`); };

  if (fullName !== undefined) push('full_name', fullName || null);
  if (role !== undefined) {
    if (!['admin', 'reception'].includes(role)) throw new Error('دور غير صالح — admin أو reception');
    push('role', role);
  }
  if (active !== undefined) push('active', !!active);
  if (password) push('password_hash', await bcrypt.hash(password, 10));

  if (!updates.length) return user;
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING ${PUBLIC_USER}`,
    params
  );
  return rows[0];
}

module.exports = {
  login, me, requireAuth, requireAdmin, changePassword,
  listUsers, createUser, updateUser,
};

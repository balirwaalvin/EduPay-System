const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'edupay.db');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  createTables();
  seedDefaults();
  saveDatabase();
  return db;
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getDb() {
  return db;
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','accountant','teacher')),
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      must_change_password INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      employee_id TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      position TEXT,
      salary_scale TEXT NOT NULL DEFAULT 'Scale_1',
      date_joined TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS salary_structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      salary_scale TEXT NOT NULL,
      basic_salary REAL NOT NULL DEFAULT 0,
      housing_allowance REAL DEFAULT 0,
      transport_allowance REAL DEFAULT 0,
      medical_allowance REAL DEFAULT 0,
      other_allowance REAL DEFAULT 0,
      tax_percentage REAL DEFAULT 0,
      nssf_percentage REAL DEFAULT 5,
      loan_deduction REAL DEFAULT 0,
      other_deduction REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payroll (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','processed','approved','paid')),
      total_gross REAL DEFAULT 0,
      total_deductions REAL DEFAULT 0,
      total_net REAL DEFAULT 0,
      processed_by INTEGER,
      approved_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (processed_by) REFERENCES users(id),
      FOREIGN KEY (approved_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payroll_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_id INTEGER NOT NULL,
      teacher_id INTEGER NOT NULL,
      basic_salary REAL DEFAULT 0,
      housing_allowance REAL DEFAULT 0,
      transport_allowance REAL DEFAULT 0,
      medical_allowance REAL DEFAULT 0,
      other_allowance REAL DEFAULT 0,
      gross_salary REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      nssf_amount REAL DEFAULT 0,
      loan_deduction REAL DEFAULT 0,
      other_deduction REAL DEFAULT 0,
      total_deductions REAL DEFAULT 0,
      net_salary REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'Pending' CHECK(payment_status IN ('Paid','Pending')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (payroll_id) REFERENCES payroll(id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT UNIQUE NOT NULL,
      config_value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function seedDefaults() {
  // Seed admin user
  const adminExists = db.exec("SELECT id FROM users WHERE username = 'admin'");
  if (adminExists.length === 0 || adminExists[0].values.length === 0) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.run(
      `INSERT INTO users (username, password, role, full_name, email, must_change_password)
       VALUES (?, ?, 'admin', 'System Administrator', 'admin@edupay.com', 0)`,
      ['admin', hashedPassword]
    );
  }

  // Seed default salary structures
  const scalesExist = db.exec("SELECT id FROM salary_structures LIMIT 1");
  if (scalesExist.length === 0 || scalesExist[0].values.length === 0) {
    const scales = [
      { scale: 'Scale_1', basic: 800000, housing: 100000, transport: 50000, medical: 30000, tax: 10 },
      { scale: 'Scale_2', basic: 1200000, housing: 150000, transport: 80000, medical: 50000, tax: 15 },
      { scale: 'Scale_3', basic: 1800000, housing: 200000, transport: 100000, medical: 80000, tax: 20 },
      { scale: 'Scale_4', basic: 2500000, housing: 300000, transport: 150000, medical: 100000, tax: 25 },
      { scale: 'Scale_5', basic: 3500000, housing: 400000, transport: 200000, medical: 150000, tax: 30 },
    ];
    for (const s of scales) {
      db.run(
        `INSERT INTO salary_structures (salary_scale, basic_salary, housing_allowance, transport_allowance, medical_allowance, tax_percentage, nssf_percentage)
         VALUES (?, ?, ?, ?, ?, ?, 5)`,
        [s.scale, s.basic, s.housing, s.transport, s.medical, s.tax]
      );
    }
  }

  // Seed system config
  const configExists = db.exec("SELECT id FROM system_config LIMIT 1");
  if (configExists.length === 0 || configExists[0].values.length === 0) {
    const configs = [
      { key: 'payroll_period', value: 'monthly' },
      { key: 'currency', value: 'UGX' },
      { key: 'school_name', value: 'EduPay School' },
      { key: 'tax_enabled', value: 'true' },
      { key: 'nssf_percentage', value: '5' },
    ];
    for (const c of configs) {
      db.run(
        "INSERT INTO system_config (config_key, config_value) VALUES (?, ?)",
        [c.key, c.value]
      );
    }
  }
}

module.exports = { initDatabase, getDb, saveDatabase };

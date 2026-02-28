const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'edupay.db');

let db = null;

function initDatabase() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);

  // WAL mode: writes go directly to disk, crash-safe, faster concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables();
  seedDefaults();
  return db;
}

function getDb() {
  return db;
}

function createTables() {
  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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
  const adminExists = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (!adminExists) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare(
      `INSERT INTO users (username, password, role, full_name, email, must_change_password)
       VALUES (?, ?, 'admin', 'System Administrator', 'admin@edupay.com', 0)`
    ).run('admin', hashedPassword);
  }

  // Seed default salary structures
  const scalesExist = db.prepare("SELECT id FROM salary_structures LIMIT 1").get();
  if (!scalesExist) {
    const insertScale = db.prepare(
      `INSERT INTO salary_structures (salary_scale, basic_salary, housing_allowance, transport_allowance, medical_allowance, tax_percentage, nssf_percentage)
       VALUES (?, ?, ?, ?, ?, ?, 5)`
    );
    const scales = [
      { scale: 'Scale_1', basic: 800000,  housing: 100000, transport: 50000,  medical: 30000,  tax: 10 },
      { scale: 'Scale_2', basic: 1200000, housing: 150000, transport: 80000,  medical: 50000,  tax: 15 },
      { scale: 'Scale_3', basic: 1800000, housing: 200000, transport: 100000, medical: 80000,  tax: 20 },
      { scale: 'Scale_4', basic: 2500000, housing: 300000, transport: 150000, medical: 100000, tax: 25 },
      { scale: 'Scale_5', basic: 3500000, housing: 400000, transport: 200000, medical: 150000, tax: 30 },
    ];
    db.transaction((rows) => {
      for (const s of rows) insertScale.run(s.scale, s.basic, s.housing, s.transport, s.medical, s.tax);
    })(scales);
  }

  // Seed system config
  const configExists = db.prepare("SELECT id FROM system_config LIMIT 1").get();
  if (!configExists) {
    const insertConfig = db.prepare("INSERT INTO system_config (config_key, config_value) VALUES (?, ?)");
    const configs = [
      ['payroll_period', 'monthly'],
      ['currency',       'UGX'],
      ['school_name',    'EduPay School'],
      ['tax_enabled',    'true'],
      ['nssf_percentage','5'],
    ];
    db.transaction((rows) => {
      for (const [k, v] of rows) insertConfig.run(k, v);
    })(configs);
  }
}

module.exports = { initDatabase, getDb, DB_PATH };

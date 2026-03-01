require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// DigitalOcean App Platform injects DATABASE_URL; fall back to individual PG* vars.
// We strip sslmode from the URL and pass ssl as an object so pg doesn't conflict.
function buildPoolConfig() {
  const raw = process.env.DATABASE_URL;

  if (raw && raw.startsWith('postgres')) {
    // Remove sslmode from the query string so pg won't have a conflicting option
    const connectionString = raw.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
    const useSSL = raw.includes('sslmode=');
    console.log('[DB] Using DATABASE_URL, ssl:', useSSL);
    return {
      connectionString,
      ssl: useSSL ? { rejectUnauthorized: false } : false
    };
  }

  // Fall back to individual connection variables (also injected by DO App Platform)
  if (process.env.PGHOST || process.env.DATABASE_HOST) {
    const config = {
      host:     process.env.PGHOST     || process.env.DATABASE_HOST,
      port:     process.env.PGPORT     || process.env.DATABASE_PORT     || 25060,
      database: process.env.PGDATABASE || process.env.DATABASE_NAME,
      user:     process.env.PGUSER     || process.env.DATABASE_USERNAME,
      password: process.env.PGPASSWORD || process.env.DATABASE_PASSWORD,
      ssl: { rejectUnauthorized: false }
    };
    console.log('[DB] Using individual connection vars, host:', config.host);
    return config;
  }

  // Nothing configured — crash with a clear message
  throw new Error(
    'No database configuration found.\n' +
    'Set DATABASE_URL (or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD) in your environment.'
  );
}

const pool = new Pool(buildPoolConfig());

async function initDatabase() {
  await createTables();
  await seedDefaults();
}

function getDb() {
  return pool;
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','accountant','teacher')),
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      must_change_password INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      employee_id TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      position TEXT,
      salary_scale TEXT NOT NULL DEFAULT 'Scale_1',
      date_joined TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accountants (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      employee_id TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      department TEXT,
      date_joined TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_structures (
      id SERIAL PRIMARY KEY,
      salary_scale TEXT NOT NULL,
      basic_salary NUMERIC NOT NULL DEFAULT 0,
      housing_allowance NUMERIC DEFAULT 0,
      transport_allowance NUMERIC DEFAULT 0,
      medical_allowance NUMERIC DEFAULT 0,
      other_allowance NUMERIC DEFAULT 0,
      tax_percentage NUMERIC DEFAULT 0,
      nssf_percentage NUMERIC DEFAULT 5,
      loan_deduction NUMERIC DEFAULT 0,
      other_deduction NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll (
      id SERIAL PRIMARY KEY,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','processed','approved','paid')),
      total_gross NUMERIC DEFAULT 0,
      total_deductions NUMERIC DEFAULT 0,
      total_net NUMERIC DEFAULT 0,
      processed_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_items (
      id SERIAL PRIMARY KEY,
      payroll_id INTEGER NOT NULL REFERENCES payroll(id),
      teacher_id INTEGER NOT NULL REFERENCES teachers(id),
      basic_salary NUMERIC DEFAULT 0,
      housing_allowance NUMERIC DEFAULT 0,
      transport_allowance NUMERIC DEFAULT 0,
      medical_allowance NUMERIC DEFAULT 0,
      other_allowance NUMERIC DEFAULT 0,
      gross_salary NUMERIC DEFAULT 0,
      tax_amount NUMERIC DEFAULT 0,
      nssf_amount NUMERIC DEFAULT 0,
      loan_deduction NUMERIC DEFAULT 0,
      other_deduction NUMERIC DEFAULT 0,
      total_deductions NUMERIC DEFAULT 0,
      net_salary NUMERIC DEFAULT 0,
      payment_status TEXT DEFAULT 'Pending' CHECK(payment_status IN ('Paid','Pending')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_config (
      id SERIAL PRIMARY KEY,
      config_key TEXT UNIQUE NOT NULL,
      config_value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function seedDefaults() {
  // Seed admin user
  const { rows: adminRows } = await pool.query("SELECT id FROM users WHERE username = 'admin'");
  if (!adminRows.length) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    await pool.query(
      `INSERT INTO users (username, password, role, full_name, email, must_change_password)
       VALUES ($1, $2, 'admin', 'System Administrator', 'admin@edupay.com', 0)`,
      ['admin', hashedPassword]
    );
  }

  // Seed default salary structures
  const { rows: scaleRows } = await pool.query("SELECT id FROM salary_structures LIMIT 1");
  if (!scaleRows.length) {
    const scales = [
      ['Scale_1', 800000,  100000, 50000,  30000,  10],
      ['Scale_2', 1200000, 150000, 80000,  50000,  15],
      ['Scale_3', 1800000, 200000, 100000, 80000,  20],
      ['Scale_4', 2500000, 300000, 150000, 100000, 25],
      ['Scale_5', 3500000, 400000, 200000, 150000, 30],
    ];
    for (const [scale, basic, housing, transport, medical, tax] of scales) {
      await pool.query(
        `INSERT INTO salary_structures (salary_scale, basic_salary, housing_allowance, transport_allowance, medical_allowance, tax_percentage, nssf_percentage)
         VALUES ($1, $2, $3, $4, $5, $6, 5)`,
        [scale, basic, housing, transport, medical, tax]
      );
    }
  }

  // Seed system config
  const { rows: configRows } = await pool.query("SELECT id FROM system_config LIMIT 1");
  if (!configRows.length) {
    const configs = [
      ['payroll_period', 'monthly'],
      ['currency',       'UGX'],
      ['school_name',    'EduPay School'],
      ['tax_enabled',    'true'],
      ['nssf_percentage','5'],
    ];
    for (const [k, v] of configs) {
      await pool.query("INSERT INTO system_config (config_key, config_value) VALUES ($1, $2)", [k, v]);
    }
  }
}

module.exports = { initDatabase, getDb };

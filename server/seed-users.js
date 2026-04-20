require('dotenv').config();
const { initDatabase, seedDefaultUsers } = require('./database');

async function run() {
  try {
    // Ensures schema exists before idempotently seeding default login accounts.
    await initDatabase();
    await seedDefaultUsers();
    console.log('[DB] User seeding completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('[DB] User seeding failed:', error.message);
    process.exit(1);
  }
}

run();

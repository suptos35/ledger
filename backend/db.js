const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'ledger.db');
const db = new Database(dbPath);

// Enable foreign key constraints and WAL mode for reliability and performance
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Initialize schema
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('debit', 'credit')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_account_id ON entries(account_id);
    CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);
  `);
}

initDb();

module.exports = db;

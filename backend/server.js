const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Helper: Calculate current balance of an account
function getAccountBalance(accountId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
    FROM entries
    WHERE account_id = ?
  `).get(accountId);
  return row ? row.balance : 0;
}

// Helper: Check if account exists
function findAccount(accountId) {
  return db.prepare(`SELECT id, name, created_at FROM accounts WHERE id = ?`).get(accountId);
}

// -------------------------------------------------------------
// Account Endpoints
// -------------------------------------------------------------

// POST /accounts - Create a new account
app.post('/accounts', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Account name is required and cannot be empty.' });
  }

  const trimmedName = name.trim();
  const info = db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(trimmedName);
  const newAccount = db.prepare(`SELECT id, name, created_at FROM accounts WHERE id = ?`).get(info.lastInsertRowid);

  return res.status(201).json({
    ...newAccount,
    balance: 0
  });
});

// GET /accounts - List all accounts with computed balance
app.get('/accounts', (req, res) => {
  const accounts = db.prepare(`
    SELECT a.id, a.name, a.created_at,
           COALESCE(SUM(CASE WHEN e.type = 'credit' THEN e.amount ELSE -e.amount END), 0) AS balance
    FROM accounts a
    LEFT JOIN entries e ON a.id = e.account_id
    GROUP BY a.id
    ORDER BY a.id ASC
  `).all();

  return res.json(accounts);
});

// GET /accounts/:id - Get single account with computed balance
app.get('/accounts/:id', (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (isNaN(accountId)) {
    return res.status(400).json({ error: 'Invalid account ID.' });
  }

  const account = db.prepare(`
    SELECT a.id, a.name, a.created_at,
           COALESCE(SUM(CASE WHEN e.type = 'credit' THEN e.amount ELSE -e.amount END), 0) AS balance
    FROM accounts a
    LEFT JOIN entries e ON a.id = e.account_id
    WHERE a.id = ?
    GROUP BY a.id
  `).get(accountId);

  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  return res.json(account);
});

// -------------------------------------------------------------
// Entry Endpoints
// -------------------------------------------------------------

// POST /accounts/:id/entries - Record debit or credit entry
app.post('/accounts/:id/entries', (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (isNaN(accountId)) {
    return res.status(400).json({ error: 'Invalid account ID.' });
  }

  const account = findAccount(accountId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const { type, amount, description } = req.body;

  // Validation
  if (type !== 'debit' && type !== 'credit') {
    return res.status(400).json({ error: "Entry type must be either 'debit' or 'credit'." });
  }

  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive integer representing cents.' });
  }

  const desc = description && typeof description === 'string' ? description.trim() : null;

  // Use a transaction for overdraft check + insert to guarantee atomicity and race prevention
  const insertEntryTx = db.transaction(() => {
    if (type === 'debit') {
      const currentBalance = getAccountBalance(accountId);
      if (currentBalance < amount) {
        throw new Error('INSUFFICIENT_BALANCE');
      }
    }

    const insertResult = db.prepare(`
      INSERT INTO entries (account_id, type, amount, description)
      VALUES (?, ?, ?, ?)
    `).run(accountId, type, amount, desc);

    const newEntry = db.prepare(`
      SELECT id, account_id, type, amount, description, created_at
      FROM entries
      WHERE id = ?
    `).get(insertResult.lastInsertRowid);

    const newBalance = getAccountBalance(accountId);

    return { ...newEntry, balance_after: newBalance };
  });

  try {
    const result = insertEntryTx();
    return res.status(201).json(result);
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Insufficient balance for debit entry.' });
    }
    console.error('Error recording entry:', err);
    return res.status(500).json({ error: 'Internal server error recording entry.' });
  }
});

// GET /accounts/:id/entries - List entries with running balance computed on the fly
app.get('/accounts/:id/entries', (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (isNaN(accountId)) {
    return res.status(400).json({ error: 'Invalid account ID.' });
  }

  const account = findAccount(accountId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  // Running balance calculated point-in-time via SQL window function, newest entries first
  const entries = db.prepare(`
    SELECT id, account_id, type, amount, description, created_at,
           SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END)
             OVER (ORDER BY id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
    FROM entries
    WHERE account_id = ?
    ORDER BY id DESC
  `).all(accountId);

  return res.json(entries);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server if not imported
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Mini Transaction Ledger backend listening on port ${PORT}`);
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;

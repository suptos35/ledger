const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Maximum transaction sanity limit: $100,000,000.00 (10 billion cents)
const MAX_AMOUNT_CENTS = 10_000_000_000;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 255;

app.use(cors());
app.use(express.json());

// -------------------------------------------------------------
// Database Helper Functions
// -------------------------------------------------------------

function getAccountBalance(accountId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
    FROM entries
    WHERE account_id = ?
  `).get(accountId);
  return row ? row.balance : 0;
}

function findAccount(accountId) {
  return db.prepare(`SELECT id, name, created_at FROM accounts WHERE id = ?`).get(accountId);
}

// -------------------------------------------------------------
// Centralized Input Validators
// -------------------------------------------------------------

function validateAccountName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Account name is required and must be a string.' };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Account name cannot be empty or whitespace.' };
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { valid: false, error: `Account name cannot exceed ${MAX_NAME_LENGTH} characters.` };
  }
  return { valid: true, value: trimmed };
}

function validateAmount(amount) {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    return { valid: false, error: 'Amount must be an integer representing cents.' };
  }
  if (amount <= 0) {
    return { valid: false, error: 'Amount must be greater than zero.' };
  }
  if (amount > MAX_AMOUNT_CENTS) {
    return { valid: false, error: `Amount exceeds maximum allowable transaction limit ($${MAX_AMOUNT_CENTS / 100}).` };
  }
  return { valid: true, value: amount };
}

function validateDescription(desc) {
  if (!desc) return { valid: true, value: null };
  if (typeof desc !== 'string') {
    return { valid: false, error: 'Description must be a string.' };
  }
  const trimmed = desc.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, error: `Description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.` };
  }
  return { valid: true, value: trimmed.length > 0 ? trimmed : null };
}

// -------------------------------------------------------------
// Account Endpoints
// -------------------------------------------------------------

// POST /accounts - Create a new account
app.post('/accounts', (req, res) => {
  const nameValidation = validateAccountName(req.body.name);
  if (!nameValidation.valid) {
    return res.status(400).json({ error: nameValidation.error });
  }

  const info = db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(nameValidation.value);
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

  const { type } = req.body;
  if (type !== 'debit' && type !== 'credit') {
    return res.status(400).json({ error: "Entry type must be either 'debit' or 'credit'." });
  }

  const amountValidation = validateAmount(req.body.amount);
  if (!amountValidation.valid) {
    return res.status(400).json({ error: amountValidation.error });
  }

  const descValidation = validateDescription(req.body.description);
  if (!descValidation.valid) {
    return res.status(400).json({ error: descValidation.error });
  }

  const amount = amountValidation.value;
  const desc = descValidation.value;

  // Atomic overdraft check + entry insertion
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

// GET /accounts/:id/entries - List entries with point-in-time running balance
app.get('/accounts/:id/entries', (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (isNaN(accountId)) {
    return res.status(400).json({ error: 'Invalid account ID.' });
  }

  const account = findAccount(accountId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

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

// -------------------------------------------------------------
// Transfer Endpoint (Atomic Double-Entry Transactions)
// -------------------------------------------------------------

// POST /transfers - Transfer money between two accounts atomically
app.post('/transfers', (req, res) => {
  const fromAccountId = parseInt(req.body.from_account_id || req.body.fromAccountId, 10);
  const toAccountId = parseInt(req.body.to_account_id || req.body.toAccountId, 10);

  if (isNaN(fromAccountId) || isNaN(toAccountId)) {
    return res.status(400).json({ error: 'Both from_account_id and to_account_id are required integers.' });
  }

  if (fromAccountId === toAccountId) {
    return res.status(400).json({ error: 'Cannot transfer funds to the same account.' });
  }

  const fromAccount = findAccount(fromAccountId);
  if (!fromAccount) {
    return res.status(404).json({ error: `Originating account #${fromAccountId} not found.` });
  }

  const toAccount = findAccount(toAccountId);
  if (!toAccount) {
    return res.status(404).json({ error: `Destination account #${toAccountId} not found.` });
  }

  const amountValidation = validateAmount(req.body.amount);
  if (!amountValidation.valid) {
    return res.status(400).json({ error: amountValidation.error });
  }

  const descValidation = validateDescription(req.body.description);
  if (!descValidation.valid) {
    return res.status(400).json({ error: descValidation.error });
  }

  const amount = amountValidation.value;
  const userDesc = descValidation.value;

  const senderDesc = userDesc
    ? `Transfer to ${toAccount.name} (#${toAccountId}): ${userDesc}`
    : `Transfer to ${toAccount.name} (#${toAccountId})`;

  const recipientDesc = userDesc
    ? `Transfer from ${fromAccount.name} (#${fromAccountId}): ${userDesc}`
    : `Transfer from ${fromAccount.name} (#${fromAccountId})`;

  // Atomically perform debit and credit inside a single SQLite transaction
  const executeTransferTx = db.transaction(() => {
    const senderBalance = getAccountBalance(fromAccountId);
    if (senderBalance < amount) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    // 1. Debit origin account
    const debitRes = db.prepare(`
      INSERT INTO entries (account_id, type, amount, description)
      VALUES (?, 'debit', ?, ?)
    `).run(fromAccountId, amount, senderDesc);

    // 2. Credit destination account
    const creditRes = db.prepare(`
      INSERT INTO entries (account_id, type, amount, description)
      VALUES (?, 'credit', ?, ?)
    `).run(toAccountId, amount, recipientDesc);

    const fromBalanceAfter = getAccountBalance(fromAccountId);
    const toBalanceAfter = getAccountBalance(toAccountId);

    return {
      debitEntryId: debitRes.lastInsertRowid,
      creditEntryId: creditRes.lastInsertRowid,
      fromBalanceAfter,
      toBalanceAfter,
    };
  });

  try {
    const result = executeTransferTx();
    return res.status(201).json({
      message: 'Transfer completed successfully.',
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      amount,
      from_balance: result.fromBalanceAfter,
      to_balance: result.toBalanceAfter,
      debit_entry_id: result.debitEntryId,
      credit_entry_id: result.creditEntryId,
    });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Originating account has insufficient balance for transfer.' });
    }
    console.error('Error executing transfer:', err);
    return res.status(500).json({ error: 'Internal server error processing transfer.' });
  }
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

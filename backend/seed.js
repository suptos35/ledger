// Seed database with realistic demo accounts and transactions
const db = require('./db');

function seed() {
  console.log('Clearing existing data...');
  db.exec(`
    DELETE FROM entries;
    DELETE FROM accounts;
    DELETE FROM sqlite_sequence;
  `);

  console.log('Seeding demo accounts...');
  const createAccount = db.prepare(`INSERT INTO accounts (name, created_at) VALUES (?, ?)`);
  const createEntry = db.prepare(`
    INSERT INTO entries (account_id, type, amount, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  // 1. Primary Checking Account
  const acc1 = createAccount.run('Primary Checking', daysAgo(10));
  const acc1Id = acc1.lastInsertRowid;

  createEntry.run(acc1Id, 'credit', 500000, 'Initial payroll deposit', daysAgo(10)); // +$5,000.00
  createEntry.run(acc1Id, 'debit', 14550, 'Whole Foods Market', daysAgo(8));        // -$145.50
  createEntry.run(acc1Id, 'debit', 8200, 'Electric & Utility bill', daysAgo(6));      // -$82.00
  createEntry.run(acc1Id, 'credit', 75000, 'Freelance consulting payment', daysAgo(4)); // +$750.00
  createEntry.run(acc1Id, 'debit', 4500, 'Coffee & lunch meetings', daysAgo(2));     // -$45.00

  // 2. High-Yield Savings Account
  const acc2 = createAccount.run('High-Yield Savings', daysAgo(15));
  const acc2Id = acc2.lastInsertRowid;

  createEntry.run(acc2Id, 'credit', 2500000, 'Initial reserve transfer', daysAgo(15)); // +$25,000.00
  createEntry.run(acc2Id, 'credit', 9375, 'Monthly APY interest payment', daysAgo(1));   // +$93.75

  // 3. Operational Treasury
  const acc3 = createAccount.run('Corporate Treasury', daysAgo(20));
  const acc3Id = acc3.lastInsertRowid;

  createEntry.run(acc3Id, 'credit', 10000000, 'Angel Seed Investment', daysAgo(20)); // +$100,000.00
  createEntry.run(acc3Id, 'debit', 125000, 'AWS Cloud Infrastructure', daysAgo(12));  // -$1,250.00
  createEntry.run(acc3Id, 'debit', 45000, 'Domain & SSL Renewals', daysAgo(5));       // -$450.00

  // Inter-account transfer: Checking -> Savings
  createEntry.run(acc1Id, 'debit', 100000, 'Transfer to High-Yield Savings (#2): Emergency fund replenishment', daysAgo(1));
  createEntry.run(acc2Id, 'credit', 100000, 'Transfer from Primary Checking (#1): Emergency fund replenishment', daysAgo(1));

  console.log('✅ Demo seed data successfully populated:');
  console.log(`- Primary Checking (#${acc1Id})`);
  console.log(`- High-Yield Savings (#${acc2Id})`);
  console.log(`- Corporate Treasury (#${acc3Id})`);
}

seed();

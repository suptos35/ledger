// Test suite for Mini Transaction Ledger backend API
const http = require('http');

process.env.DB_PATH = ':memory:'; // Use in-memory SQLite database for isolated test runs
const app = require('./server');

function makeRequest(server, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: port,
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : null;
            resolve({ status: res.statusCode, body: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, raw: data });
          }
        });
      }
    );

    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${message}`);
}

async function runTests() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  console.log('--- Starting Functional & Edge Case Tests ---');

  // 1. Health check
  const healthRes = await makeRequest(server, 'GET', '/health');
  assert(healthRes.status === 200 && healthRes.body.status === 'ok', 'GET /health returns ok');

  // 2. Create account
  const createAccRes = await makeRequest(server, 'POST', '/accounts', { name: 'Main Checking' });
  assert(createAccRes.status === 201, 'POST /accounts creates account (201)');
  assert(createAccRes.body.balance === 0, 'New account has balance 0');
  const accountId = createAccRes.body.id;

  // 3. List accounts
  const listAccRes = await makeRequest(server, 'GET', '/accounts');
  assert(listAccRes.status === 200 && listAccRes.body.length === 1, 'GET /accounts lists 1 account');
  assert(listAccRes.body[0].balance === 0, 'Account in list has balance 0');

  // 4. Credit 1000 cents ($10.00)
  const creditRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, {
    type: 'credit',
    amount: 1000,
    description: 'Initial deposit'
  });
  assert(creditRes.status === 201, 'POST /accounts/:id/entries credit returns 201');
  assert(creditRes.body.balance_after === 1000, 'Balance after credit is 1000');

  // 5. Debit 400 cents ($4.00)
  const debitRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, {
    type: 'debit',
    amount: 400,
    description: 'Groceries'
  });
  assert(debitRes.status === 201, 'POST /accounts/:id/entries debit returns 201');
  assert(debitRes.body.balance_after === 600, 'Balance after debit is 600');

  // 6. Overdraft test: Try to debit 700 cents when balance is 600
  const overdraftRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, {
    type: 'debit',
    amount: 700,
    description: 'Expensive item'
  });
  assert(overdraftRes.status === 400, 'Overdraft debit rejected with 400');
  assert(overdraftRes.body.error.includes('Insufficient balance'), 'Overdraft returns Insufficient balance error');

  // 7. Verify balance unchanged after rejected overdraft
  const accCheck = await makeRequest(server, 'GET', `/accounts/${accountId}`);
  assert(accCheck.body.balance === 600, 'Account balance remains 600 after rejected debit');

  // 8. Add more entries to test running balance calculation
  await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 500, description: 'Freelance pay' }); // balance: 1100
  await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'debit', amount: 100, description: 'Coffee' }); // balance: 1000
  await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 250, description: 'Refund' }); // balance: 1250

  const entriesRes = await makeRequest(server, 'GET', `/accounts/${accountId}/entries`);
  assert(entriesRes.status === 200, 'GET /accounts/:id/entries returns 200');
  assert(entriesRes.body.length === 5, 'Found 5 entries');

  // Expected running balance sequence (from newest to oldest):
  // 1: +1000 -> 1000
  // 2: -400  -> 600
  // 3: +500  -> 1100
  // 4: -100  -> 1000
  // 5: +250  -> 1250
  const runningBalances = entriesRes.body.map((e) => e.running_balance);
  const expectedDescRunningBalances = [1250, 1000, 1100, 600, 1000];
  assert(
    JSON.stringify(runningBalances) === JSON.stringify(expectedDescRunningBalances),
    `Running balances match point-in-time calculation (expected ${expectedDescRunningBalances}, got ${runningBalances})`
  );

  // 9. Edge Cases & Validations
  const invalidNameRes = await makeRequest(server, 'POST', '/accounts', { name: '   ' });
  assert(invalidNameRes.status === 400, 'Blank account name rejected with 400');

  const negAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: -50 });
  assert(negAmountRes.status === 400, 'Negative amount rejected with 400');

  const zeroAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 0 });
  assert(zeroAmountRes.status === 400, 'Zero amount rejected with 400');

  const floatAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 12.5 });
  assert(floatAmountRes.status === 400, 'Float amount rejected with 400 (only integer cents allowed)');

  const stringAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: '1000' });
  assert(stringAmountRes.status === 400, 'String amount rejected with 400');

  const invalidTypeRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'deposit', amount: 100 });
  assert(invalidTypeRes.status === 400, "Invalid type (not 'debit'/'credit') rejected with 400");

  const nonExistentAccRes = await makeRequest(server, 'POST', `/accounts/99999/entries`, { type: 'credit', amount: 100 });
  assert(nonExistentAccRes.status === 404, 'Entry against nonexistent account returns 404');

  console.log('\n--- Running Concurrency & Race-Condition Test (50 parallel requests) ---');
  // Account currently has balance 1250 cents.
  // We'll fire 25 parallel credits (+100) and 25 parallel debits (-50).
  // Net expected change: + (25 * 100) - (25 * 50) = + 2500 - 1250 = +1250.
  // Final expected balance: 1250 + 1250 = 2500 cents.
  const promises = [];
  for (let i = 0; i < 25; i++) {
    promises.push(makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 100, description: `Parallel Credit ${i}` }));
    promises.push(makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'debit', amount: 50, description: `Parallel Debit ${i}` }));
  }

  await Promise.all(promises);

  const finalAccRes = await makeRequest(server, 'GET', `/accounts/${accountId}`);
  assert(
    finalAccRes.body.balance === 2500,
    `Final balance after 50 parallel requests is exact: ${finalAccRes.body.balance} cents (expected 2500 cents)`
  );

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
  server.close();
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});

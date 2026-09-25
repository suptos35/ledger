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

  console.log('--- 1. Health & Core Account CRUD Tests ---');

  const healthRes = await makeRequest(server, 'GET', '/health');
  assert(healthRes.status === 200 && healthRes.body.status === 'ok', 'GET /health returns ok');

  const createAccRes = await makeRequest(server, 'POST', '/accounts', { name: 'Main Checking' });
  assert(createAccRes.status === 201, 'POST /accounts creates account (201)');
  assert(createAccRes.body.balance === 0, 'New account has balance 0');
  const accountId = createAccRes.body.id;

  const listAccRes = await makeRequest(server, 'GET', '/accounts');
  assert(listAccRes.status === 200 && listAccRes.body.length === 1, 'GET /accounts lists 1 account');
  assert(listAccRes.body[0].balance === 0, 'Account in list has balance 0');

  console.log('\n--- 2. Entries, Overdraft, & Running Balances ---');

  const creditRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, {
    type: 'credit',
    amount: 1000,
    description: 'Initial deposit'
  });
  assert(creditRes.status === 201, 'POST /accounts/:id/entries credit returns 201');
  assert(creditRes.body.balance_after === 1000, 'Balance after credit is 1000');

  const debitRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, {
    type: 'debit',
    amount: 400,
    description: 'Groceries'
  });
  assert(debitRes.status === 201, 'POST /accounts/:id/entries debit returns 201');
  assert(debitRes.body.balance_after === 600, 'Balance after debit is 600');

  const overdraftRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, {
    type: 'debit',
    amount: 700,
    description: 'Expensive item'
  });
  assert(overdraftRes.status === 400, 'Overdraft debit rejected with 400');
  assert(overdraftRes.body.error.includes('Insufficient balance'), 'Overdraft returns Insufficient balance error');

  const accCheck = await makeRequest(server, 'GET', `/accounts/${accountId}`);
  assert(accCheck.body.balance === 600, 'Account balance remains 600 after rejected debit');

  await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 500, description: 'Freelance' });
  await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'debit', amount: 100, description: 'Coffee' });
  await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 250, description: 'Refund' });

  const entriesRes = await makeRequest(server, 'GET', `/accounts/${accountId}/entries`);
  assert(entriesRes.status === 200, 'GET /accounts/:id/entries returns 200');
  assert(entriesRes.body.length === 5, 'Found 5 entries');

  const runningBalances = entriesRes.body.map((e) => e.running_balance);
  const expectedDescRunningBalances = [1250, 1000, 1100, 600, 1000];
  assert(
    JSON.stringify(runningBalances) === JSON.stringify(expectedDescRunningBalances),
    `Running balances match point-in-time calculation (expected ${expectedDescRunningBalances}, got ${runningBalances})`
  );

  console.log('\n--- 3. Validation Edge Cases & Sanity Limits (Layer 2) ---');

  const blankNameRes = await makeRequest(server, 'POST', '/accounts', { name: '   ' });
  assert(blankNameRes.status === 400, 'Blank account name rejected with 400');

  const longNameRes = await makeRequest(server, 'POST', '/accounts', { name: 'A'.repeat(101) });
  assert(longNameRes.status === 400, 'Overly long account name (>100 chars) rejected with 400');

  const negAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: -50 });
  assert(negAmountRes.status === 400, 'Negative amount rejected with 400');

  const zeroAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 0 });
  assert(zeroAmountRes.status === 400, 'Zero amount rejected with 400');

  const floatAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 12.5 });
  assert(floatAmountRes.status === 400, 'Float amount rejected with 400');

  const excessiveAmountRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 999_999_999_999_999 });
  assert(excessiveAmountRes.status === 400, 'Excessive amount exceeding sanity limit rejected with 400');

  const longDescRes = await makeRequest(server, 'POST', `/accounts/${accountId}/entries`, {
    type: 'credit',
    amount: 100,
    description: 'D'.repeat(256)
  });
  assert(longDescRes.status === 400, 'Description exceeding 255 chars rejected with 400');

  console.log('\n--- 4. Atomic Transfers Endpoint Tests (Layer 3) ---');

  // Create second account for transfer tests
  const acc2Res = await makeRequest(server, 'POST', '/accounts', { name: 'Savings Account' });
  const acc2Id = acc2Res.body.id;

  // Currently Account 1 has 1250 cents ($12.50). Account 2 has 0 cents.
  // Transfer 500 cents ($5.00) from Acc 1 to Acc 2.
  const transferRes = await makeRequest(server, 'POST', '/transfers', {
    from_account_id: accountId,
    to_account_id: acc2Id,
    amount: 500,
    description: 'Monthly savings contribution'
  });
  assert(transferRes.status === 201, 'POST /transfers succeeds with 201');
  assert(transferRes.body.from_balance === 750, 'Sender balance after transfer is 750');
  assert(transferRes.body.to_balance === 500, 'Receiver balance after transfer is 500');

  // Test self-transfer rejection
  const selfTransferRes = await makeRequest(server, 'POST', '/transfers', {
    from_account_id: accountId,
    to_account_id: accountId,
    amount: 100
  });
  assert(selfTransferRes.status === 400, 'Transfer to same account rejected with 400');

  // Test overdraft transfer rejection
  const overdraftTransferRes = await makeRequest(server, 'POST', '/transfers', {
    from_account_id: accountId,
    to_account_id: acc2Id,
    amount: 99999
  });
  assert(overdraftTransferRes.status === 400, 'Transfer with insufficient balance rejected with 400');

  // Verify balances unchanged after failed transfer
  const acc1Check = await makeRequest(server, 'GET', `/accounts/${accountId}`);
  const acc2Check = await makeRequest(server, 'GET', `/accounts/${acc2Id}`);
  assert(acc1Check.body.balance === 750, 'Sender balance remains unchanged after failed transfer');
  assert(acc2Check.body.balance === 500, 'Receiver balance remains unchanged after failed transfer');

  console.log('\n--- 5. Concurrency & Race-Condition Stress Test (50 parallel requests) ---');

  // Acc 1 currently has 750 cents.
  // 25 parallel credits (+100) and 25 parallel debits (-50).
  // Net change: +2500 - 1250 = +1250.
  // Expected final balance: 750 + 1250 = 2000 cents.
  const promises = [];
  for (let i = 0; i < 25; i++) {
    promises.push(makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'credit', amount: 100 }));
    promises.push(makeRequest(server, 'POST', `/accounts/${accountId}/entries`, { type: 'debit', amount: 50 }));
  }
  await Promise.all(promises);

  const finalAccRes = await makeRequest(server, 'GET', `/accounts/${accountId}`);
  assert(
    finalAccRes.body.balance === 2000,
    `Final balance after 50 parallel requests is exact: ${finalAccRes.body.balance} cents (expected 2000 cents)`
  );

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
  server.close();
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});

# Mini Transaction Ledger — Architecture & System Explanation

This document fulfills the **Short Written Explanation** requirement for the Full-Stack Mini Web Application Assessment.

---

## 1. Application Architecture & Data Flow

The Mini Transaction Ledger is architected as a decoupled, multi-container client-server application consisting of a React Single-Page Application (SPA) frontend, an Express REST API backend, and an embedded SQLite transactional database.

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Browser                         │
│   (React SPA: UI State, Forms, Validations, Formatters)     │
└───────────────▲─────────────────────────────┬───────────────┘
                │                             │
    HTTP GET    │                             │ HTTP POST
  (JSON arrays) │                             │ (JSON payloads)
                │                             │
┌───────────────┴─────────────────────────────▼───────────────┐
│               Express REST API (backend/server.js)          │
│   - Input Validation (boundary checks, sanity limits)       │
│   - Business Logic (overdraft prevention, transfer rules)   │
│   - Error Handling & HTTP Status Standardization            │
└──────────────────────────────┬──────────────────────────────┘
                               │
            Synchronous Driver │ (better-sqlite3)
            ACID Transactions  │ (db.transaction)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Embedded SQLite Database                    │
│   - accounts: id, name, created_at                          │
│   - entries:  id, account_id, type, amount, description     │
│   - Computed Balances via SQL Window Functions              │
└─────────────────────────────────────────────────────────────┘
```

### Runtime Flow: Recording an Entry
1. **User Interaction:** The user selects an account in the UI, toggles between Credit (Deposit) or Debit (Withdrawal), and inputs an amount in dollars.
2. **Client Validation & Preview:** The frontend immediately converts dollars to integer cents and compares debits against the active account balance. If the debit would overdraft the account, the submit button is disabled and a warning banner appears.
3. **HTTP Transport:** The frontend sends a `POST /accounts/:id/entries` request with `{ type, amount, description }` in JSON format.
4. **Backend Processing:**
   - Validates that the account exists (`404 Not Found` if missing).
   - Validates that `type` is `'credit'` or `'debit'`, and `amount` is a positive integer under the sanity limit.
   - Executes an atomic database transaction (`db.transaction`):
     - For debits: reads the current computed balance. If `balance < amount`, aborts and throws `INSUFFICIENT_BALANCE`.
     - Inserts the new row into the `entries` table.
     - Computes the updated balance.
5. **Response & UI Update:** The server returns `201 Created` with the new entry and `balance_after`. The React client updates its state cache, triggers a fresh fetch of chronological entries, and shows a confirmation toast.

---

## 2. Key Code Components and Their Purpose

| File | Purpose | Key Technical Details |
|---|---|---|
| [`backend/db.js`](./backend/db.js) | Database Connection & Schema Management | Initializes SQLite using `better-sqlite3`. Enables WAL mode (`PRAGMA journal_mode = WAL;`) for concurrent read/write performance and foreign keys (`PRAGMA foreign_keys = ON;`). Creates tables and indexes idempotently on startup. |
| [`backend/server.js`](./backend/server.js) | REST API & Core Business Logic | Contains Express routes for accounts, entries, transfers, and health checks. Houses centralized input validators, atomic transaction blocks, overdraft enforcement, and window-function balance queries. |
| [`backend/test.js`](./backend/test.js) | Automated Test Suite & Stress Runner | Tests all endpoints, edge cases (overdrafts, invalid types, negative amounts, floats), atomic rollback during failed transfers, and runs a 50-request parallel concurrency stress test against SQLite. |
| [`backend/seed.js`](./backend/seed.js) | Demo Data Seeding | Populates realistic sample accounts (Checking, Savings, Treasury) with realistic credit/debit transaction history and an inter-account transfer for demo purposes. |
| [`frontend/src/api.js`](./frontend/src/api.js) | API Client & Formatting Helpers | Abstract fetch wrapper with error handling, currency formatting (`formatCurrency` converting cents to `$X.XX`), and timestamp formatting. |
| [`frontend/src/App.jsx`](./frontend/src/App.jsx) | Main React Application Component | Manages account selection, live health monitoring, transaction entry forms, modal dialogs for new accounts and fund transfers, and live overdraft warning previews. |
| [`frontend/src/index.css`](./frontend/src/index.css) & [`App.css`](./frontend/src/App.css) | Custom Design System | Vanilla CSS styling with curated dark palette, glassmorphism headers, typography (Plus Jakarta Sans & JetBrains Mono), responsive grid layouts, and micro-animations. |
| [`docker-compose.yml`](./docker-compose.yml) | Multi-Service Container Orchestration | Defines and networks the `backend` (Node API on port 3000) and `frontend` (Nginx static web server on port 5173). |

---

## 3. How the API Works Internally

### Money as Integer Cents
Floats in modern programming languages follow IEEE 754 floating-point arithmetic, which leads to rounding inaccuracies (`0.1 + 0.2 = 0.30000000000000004`). In financial ledgers, even sub-cent inaccuracies compound over time.
- All amounts in this system are stored and calculated strictly as integer cents (e.g., $10.50 = `1050`).
- Conversion occurs exclusively at the presentation boundary in the frontend.

### Dynamic Running Balances via SQL Window Functions
Rather than storing a mutable `balance` column on `accounts` that can drift out of sync if an operation fails or bugs occur, running balances are computed at query time:
```sql
SELECT id, account_id, type, amount, description, created_at,
       SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END)
         OVER (ORDER BY id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
FROM entries
WHERE account_id = ?
ORDER BY id DESC;
```
- `ORDER BY id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` computes the cumulative sum up to each row's historical point in time.
- The outer `ORDER BY id DESC` returns the newest entries first, while preserving each historical entry's exact balance at the moment it occurred.

### Concurrency Safety & Race Condition Prevention
A common bug in asynchronous Node.js backends occurs when two requests attempt to debit the same account concurrently:
1. Request 1 reads balance ($50.00).
2. Request 2 reads balance ($50.00).
3. Request 1 inserts debit for $40.00 (balance is now $10.00).
4. Request 2 inserts debit for $40.00 (balance becomes -$30.00 overdraft).

This system prevents this race condition via two mechanisms:
1. **Synchronous Execution:** `better-sqlite3` is a synchronous C++ driver. Query execution blocks the Node event loop for the few microseconds SQLite takes to write to disk, ensuring sequential execution without interleaved async steps.
2. **Atomic Transactions (`db.transaction`):** Balance verification and row insertion are wrapped in a single database transaction, ensuring ACID isolation.

### Inter-Account Transfers (`POST /transfers`)
Transfers adhere to double-entry bookkeeping:
- A debit is recorded on the source account.
- A credit is recorded on the destination account.
- Both operations are executed inside a single `db.transaction()` wrapper. If anything fails (e.g. source account runs out of funds), both inserts roll back automatically, ensuring zero half-transfers.

---

## 4. Docker Setup & Containerization

### Backend Containerization ([`backend/Dockerfile`](./backend/Dockerfile))
- Uses `node:20-slim` as the base image.
- Installs necessary native compilation packages (`python3`, `make`, `g++`) so that `better-sqlite3`'s native C++ bindings compile cleanly across Linux architectures.
- Installs production dependencies via `npm install --omit=dev`.
- Exposes port `3000` and configures graceful SIGTERM / SIGINT shutdown.

### Frontend Multi-Stage Build ([`frontend/Dockerfile`](./frontend/Dockerfile))
To optimize image size and performance, the frontend uses a two-stage build:
1. **Stage 1 (Build):** Uses `node:20-slim` to install dependencies and run `npm run build`, producing an optimized static production bundle in `dist/`.
2. **Stage 2 (Production Server):** Copies the compiled static assets into `nginx:alpine` (`/usr/share/nginx/html`).
   - The final production image excludes all Node.js runtimes, package managers, and source files, resulting in an ultra-lightweight, high-performance static server.

### Multi-Container Orchestration ([`docker-compose.yml`](./docker-compose.yml))
`docker-compose.yml` ties both services together:
- `backend`: builds `./backend`, publishes port `3000:3000`.
- `frontend`: builds `./frontend`, publishes port `5173:80` and depends on `backend`.
- Browser clients on the host access the UI at `http://localhost:5173` and the API at `http://localhost:3000`.

# Mini Transaction Ledger

A robust full-stack transaction ledger application that allows users to create accounts, record debit/credit entries, execute atomic transfers, and compute running balances with mathematical precision and race-condition prevention.

---

## 1. Tech Stack & Architecture

- **Backend:** Node.js (v20+), Express 5
- **Database:** SQLite 3 via `better-sqlite3` (synchronous, zero race conditions)
- **Frontend:** React 19, Vite
- **Testing:** Automated Node test suite with concurrency/race-condition stress testing
- **Containerization:** Multi-stage Docker + Docker / Podman Compose

```
[ Frontend (React + Vite) ]
          │  HTTP / JSON
          ▼
[ Express REST API ]
          │  Synchronous Driver (better-sqlite3)
          ▼
[ SQLite Database (ledger.db) ]
  ├── accounts (id, name, created_at)
  └── entries  (id, account_id, type, amount, description, created_at)
```

---

## 2. Architecture & Design Decisions

### A. Money as Integer Cents (No Floating Point)
- **Decision:** All monetary amounts are received, validated, stored, and calculated strictly as integer cents (e.g., `$12.50` is stored as `1250`).
- **Rationale:** Floating-point representations (`0.1 + 0.2 !== 0.3`) introduce precision and rounding errors that are unacceptable in financial accounting systems.

### B. Dynamically Computed Running Balances via SQL Window Functions
- **Decision:** Running balances are computed on-the-fly at query time using SQLite window functions:
  ```sql
  SELECT id, account_id, type, amount, description, created_at,
         SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END)
           OVER (ORDER BY id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
  FROM entries
  WHERE account_id = ?
  ORDER BY id DESC;
  ```
- **Rationale:** Eliminates data drift and synchronization anomalies between stored balance columns and actual ledger records. The single source of truth is the immutable transaction log.

### C. Overdraft Prevention & Synchronous Concurrency Safety
- **Decision:** Debits are validated against the current account balance before execution. Both balance verification and entry insertion occur inside an atomic database transaction.
- **Rationale:** `better-sqlite3` executes synchronously on SQLite, avoiding asynchronous race conditions that can occur when parallel async callbacks read an outdated balance before writing.

### D. Atomic Transfers Between Accounts (ACID Compliance)
- **Decision:** Account-to-account transfers perform a debit on the source account and a credit on the destination account inside a single SQLite transaction (`db.transaction()`).
- **Rationale:** Guarantees that funds can never be created or destroyed midway if the server restarts or an unexpected error occurs during execution. Either both accounts update together or neither does.

---

## 3. REST API Specification

### Accounts
| Method | Endpoint | Description | Request Body | Response (Example) |
|---|---|---|---|---|
| `POST` | `/accounts` | Create an account | `{"name": "Main Checking"}` | `201 Created`: `{"id": 1, "name": "Main Checking", "balance": 0, ...}` |
| `GET` | `/accounts` | List accounts with computed balance | — | `200 OK`: `[{"id": 1, "name": "Main Checking", "balance": 1250}]` |
| `GET` | `/accounts/:id` | Get single account with balance | — | `200 OK`: `{"id": 1, "name": "Main Checking", "balance": 1250}` |

### Entries
| Method | Endpoint | Description | Request Body | Response (Example) |
|---|---|---|---|---|
| `POST` | `/accounts/:id/entries` | Record debit or credit entry | `{"type": "credit", "amount": 1000, "description": "Deposit"}` | `201 Created`: `{"id": 1, "account_id": 1, "type": "credit", "amount": 1000, "balance_after": 1000}` |
| `GET` | `/accounts/:id/entries` | List entries with running balance | — | `200 OK`: `[{"id": 1, "type": "credit", "amount": 1000, "running_balance": 1000}]` |

### Transfers
| Method | Endpoint | Description | Request Body | Response (Example) |
|---|---|---|---|---|
| `POST` | `/transfers` | Transfer funds between two accounts | `{"from_account_id": 1, "to_account_id": 2, "amount": 500, "description": "Rent"}` | `201 Created`: `{"message": "Transfer completed successfully.", "from_balance": 750, "to_balance": 500, ...}` |

### Error Responses
All errors follow a consistent JSON shape:
```json
{
  "error": "Descriptive error message"
}
```
- `400 Bad Request`: Invalid type, negative/zero/non-integer amount, blank name, transfer to self, or insufficient balance.
- `404 Not Found`: Nonexistent account.
- `500 Internal Server Error`: Unexpected database or system error.

---

## 4. Setup and Running

### Prerequisites
- Node.js LTS (v20+) or active `.venv` with `nodeenv`
- Docker or Podman

### Local Development
```bash
# 1. Activate virtual environment (if using project venv)
source .venv/bin/activate

# 2. Run backend
cd backend
npm install
npm run dev

# 3. Run frontend
cd ../frontend
npm install
npm run dev
```

### Running Backend Automated Tests
An automated test suite validates health, CRUD, input validation, overdraft rejection, window function running balances, atomic transfers, and a 50-request parallel concurrency stress test:
```bash
cd backend
npm test
```

### Containerized Execution
```bash
docker compose up --build
# Or with Podman
podman-compose up --build
```
Open your browser at `http://localhost:5173` to access the frontend, and `http://localhost:3000` to query the REST API directly.

# Mini Transaction Ledger

A full-stack transaction ledger application that allows users to create accounts, record debit/credit entries, execute atomic transfers, and compute running balances with data integrity.

## Tech Stack
- **Backend:** Node.js, Express, better-sqlite3, CORS
- **Frontend:** React, Vite
- **Database:** SQLite
- **Containerization:** Docker / Podman Compose

## Setup and Running

### Prerequisites
- Node.js LTS (v20+) or Python 3 venv with integrated nodeenv
- Docker / Podman

### Local Development
```bash
# Activate environment (if using virtual environment)
source .venv/bin/activate

# Backend
cd backend
npm install
npm run dev

# Frontend
cd ../frontend
npm install
npm run dev
```

### Containerized Run
```bash
docker compose up --build
# or
podman-compose up --build
```

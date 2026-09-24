# Mini Transaction Ledger — Full Build Plan

Deadline: **Sept 28**. Today: **Sept 25**. Budget roughly 1.5–2 focused days across the window, not one day — Docker and docs eat more time than they look like they will.

---

## 0. Tech Stack — Final Picks + Why

| Layer | Choice | Why this, over the alternatives |
|---|---|---|
| Backend | **Node.js + Express** | Most AI-training-data coverage of any backend stack — Claude/Copilot write correct Express code more reliably than Flask/.NET edge cases. One language (JS) across front+back = less context switching for you. |
| Database | **SQLite via `better-sqlite3`** | Zero setup (no DB server, no docker service for it), file-based, and critically: `better-sqlite3` is **synchronous** — every query blocks until done. That single fact kills a whole class of race-condition bugs for free (explained in Layer 1 testing). Ordinary `sqlite3` npm package is async/callback-based and is *more* hassle, not less — avoid it. |
| Frontend | **React + Vite** | Vite's dev server and build are fast and nearly zero-config, unlike Create React App (deprecated) or a hand-rolled webpack setup. Skip Tailwind/UI libraries — plain CSS, it's not graded on looks. |
| API testing | **curl / Thunder Client (VS Code extension)** | No new account needed (unlike Postman), lives right in your editor. |
| Version control | **Git + GitHub**, public or private repo, commit at every checkpoint below | This *is* graded ("meaningful commits showing development progress") — don't squash your history at the end. |
| Containerization | **Docker + docker-compose**, 2 services (backend, frontend) | No DB service needed — SQLite is just a file inside the backend container/volume. |

**Decision explicitly avoided:** an ORM (Prisma/Sequelize). For a 2-table schema, raw SQL via `better-sqlite3` is *less* code, not more, and it's easier for you to explain every line in an interview than "the ORM generated this." Use an ORM only if you already know one cold.

---

## 1. One-Time Setup (do this today, ~30–45 min)

1. Install **Node.js LTS** (v20+) — `node -v` to confirm.
2. Install **Docker Desktop**, confirm `docker --version` and `docker compose version` both work.
3. Install **VS Code** + Thunder Client extension (or just use `curl`/`curl.exe`).
4. Create the GitHub repo now, empty, with a `.gitignore` (Node template) and `README.md` stub. Clone it locally — you build inside this repo from minute one so every layer becomes a real commit.
5. Inside the repo:
   ```
   mkdir backend frontend
   cd backend && npm init -y && npm install express better-sqlite3 cors
   cd ../frontend && npm create vite@latest . -- --template react
   ```
6. First commit: `chore: project scaffold` — push it. This is checkpoint 0, proves your repo/tooling works before you write logic.

---

## 2. Project Structure (fixed from the start)

```
ledger/
├── backend/
│   ├── db.js          # SQLite connection + schema creation
│   ├── server.js       # Express app + routes
│   ├── package.json
│   └── ledger.db        # generated, gitignored
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api.js       # fetch wrapper for backend calls
│   │   └── components/
│   └── package.json
├── docker-compose.yml
├── .gitignore
└── README.md
```

---

## 3. Layer 1 — Core Data Model & CRUD (the part that must not change later)

### 3.1 Data model — decide this carefully, it's permanent

**Table: `accounts`**
| column | type | notes |
|---|---|---|
| id | INTEGER PRIMARY KEY | auto-increment |
| name | TEXT NOT NULL | |
| created_at | TEXT | ISO timestamp, default now |

**Table: `entries`**
| column | type | notes |
|---|---|---|
| id | INTEGER PRIMARY KEY | auto-increment |
| account_id | INTEGER NOT NULL | foreign key → accounts.id |
| type | TEXT NOT NULL | `'debit'` or `'credit'` — CHECK constraint |
| amount | INTEGER NOT NULL | **see decision below** |
| description | TEXT | optional |
| created_at | TEXT | ISO timestamp, default now |

**Decision — money as integer cents, not float/decimal:**
- **Chosen: store amount as integer cents** (e.g., $12.50 → `1250`). Convert to dollars only at the API response / display boundary.
- *Upside:* floats have rounding errors (`0.1 + 0.2 !== 0.3` in every language) — this is a real bug class in financial software and avoiding it is exactly the kind of decision worth explaining in your write-up.
- *Downside:* you must remember to convert cents↔dollars at both API boundaries; miss one and numbers look 100x off. Mitigate with one small `toCents()`/`toDollars()` helper used everywhere, never inline math.
- *Alternative rejected:* SQLite `REAL` (float) — simplest to type, wrong to use for money, don't do it even though it's tempting.

**Decision — balance: stored column vs computed on the fly**
- **Chosen for Layer 1: compute on the fly** — `balance = SUM(credits) - SUM(debits)` via SQL `SUM()`, run whenever you need it.
- *Upside:* balance can never drift out of sync with entries, because there's nothing to keep in sync — it's always derived fresh. Simpler to reason about and explain.
- *Downside:* slightly slower on very large histories (irrelevant at this project's scale — thousands of rows is instant for SQLite).
- *Alternative (defer to Layer 4 if you want it):* store a `balance` column on `accounts`, update it on every insert. Faster reads, but now you have two sources of truth that can disagree if a bug slips in. Explicitly mention in your README that you considered this and chose correctness over micro-optimized speed — that's a strong line for the "Architecture Understanding" grading criterion.

### 3.2 API endpoints (Layer 1 scope only)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/accounts` | `{ name }` | created account |
| GET | `/accounts` | — | list of accounts, each with computed balance |
| GET | `/accounts/:id` | — | one account + computed balance |
| POST | `/accounts/:id/entries` | `{ type, amount, description }` | created entry |
| GET | `/accounts/:id/entries` | — | list of entries, newest first, **each row includes a running balance computed at query time** |

### 3.3 Build order (do it in this exact sequence)

1. `db.js`: open SQLite file, run `CREATE TABLE IF NOT EXISTS` for both tables on startup (idempotent — safe to run every time the server starts).
2. `POST /accounts` + `GET /accounts` — prove the DB connection works end to end before touching entries.
3. `POST /accounts/:id/entries` — validate `type` is exactly `'debit'` or `'credit'`, `amount` is a positive integer, `account_id` exists (404 if not).
4. `GET /accounts/:id/entries` with running balance — this is a SQL window function (`SUM(...) OVER (ORDER BY id)`) or a small JS loop over sorted rows; either is fine, pick whichever you can explain clearly.
5. Wire the React frontend: account list page → click account → detail page with balance + entry table + "add entry" form.

### 3.4 Testing checklist — do this *before* moving to Layer 2

This is the point of building bottom-up: don't add Layer 2 features on a foundation you haven't verified.

**Functional correctness**
- [ ] Create account → appears in `GET /accounts` with balance 0.
- [ ] Add one credit of 1000 → balance is 1000.
- [ ] Add one debit of 400 → balance is 600.
- [ ] `GET /accounts/:id/entries` running-balance column matches manually hand-calculated values for a sequence of 5 mixed entries.

**Validation / edge cases**
- [ ] Negative amount → rejected (400, not a silent wrong balance).
- [ ] Amount `0` → decide and enforce a rule (reject, or allow — just be consistent and be able to say why).
- [ ] `type` not `'debit'`/`'credit'` → rejected.
- [ ] Entry against a nonexistent `account_id` → 404, not a crash.
- [ ] Non-numeric `amount` (e.g. string `"abc"`) → rejected, not silently coerced to `0` or `NaN`.

**Concurrency / "many transactions at once"**
- [ ] Write a tiny script (Node `Promise.all` firing 50 parallel `POST /entries` requests at the same account, alternating credit/debit of known amounts) and confirm the final balance exactly matches the hand-calculated expected sum. This is the single most important test in the whole project — it's the concrete proof that your synchronous-SQLite choice actually prevents race conditions in practice, not just in theory. Screenshot/log this result for your written explanation.

**Performance (quick sanity check, not a formal benchmark)**
- [ ] Insert ~5,000 entries via a small seed script, confirm `GET /accounts/:id/entries` still returns in well under a second. You don't need this to be fast, you need to be able to say you checked.

**Basic security**
- [ ] Confirm you're using **parameterized queries** everywhere (`db.prepare('... WHERE id = ?').run(id)`), never string-concatenated SQL — this is your SQL-injection defense, and it's one sentence you should be ready to say out loud in review: "all queries are parameterized, so user input is never interpolated into SQL text."
- [ ] Confirm the frontend doesn't render entry `description` as raw HTML (React escapes by default — just don't use `dangerouslySetInnerHTML` and you're safe; worth knowing *why* it's safe, not just that it is).

### 3.5 Checkpoint 1 — "submittable if you had to stop right now"

At this point you have: accounts, entries, correct balances, validated inputs, tested concurrency, no DB or Docker yet. It's not a finished submission (no Docker = fails the hard requirement), but the *logic* is done and tested.

```
git add .
git commit -m "Checkpoint 1: core account/entry CRUD with tested balance correctness"
git tag v0.1
git push --tags
```

---

## 3.6 Docker: Build It Alongside, Verify Periodically, Don't Live In It

The mistake to avoid is either extreme: doing all of Docker at the very end (high risk, per Layer 5's warning), or rebuilding your Docker containers on every code change (kills your iteration speed — a rebuild-and-restart cycle is seconds-to-minutes vs. instant hot-reload from `npm run dev`).

The fix: **your day-to-day dev loop stays 100% local** (plain `node`/`nodemon` for backend, Vite dev server for frontend). Docker exists as a periodically-run *"does the packaged version still work"* check, not your main workspace. You touch it at defined points, confirm it, then go back to local dev.

### Step A — Right after Checkpoint 1 (v0.1): stand up a bare Dockerfile, backend only

Don't wait for the frontend to exist. With just the CRUD backend working locally, write the simplest possible backend Dockerfile:

```dockerfile
# backend/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

Add a `.dockerignore` in `backend/` (`node_modules`, `ledger.db`) so builds stay fast and you don't ship your local DB file into the image.

**Verify:** `docker build -t ledger-backend .` then `docker run -p 3000:3000 ledger-backend`, hit `GET /accounts` from your browser or curl on the host. If this works, you've proven the one thing most likely to break later (base image, port exposure, `npm install` inside Linux vs your host OS) *while the app is still trivially simple to debug*. Commit the Dockerfile now — don't leave it uncommitted while you move on.

### Step B — Once the frontend has a working account list + detail page (partway through Layer 1/3.5): add its Dockerfile + first docker-compose.yml

Frontend needs a **multi-stage build** — build the static files with Vite, then serve them with something lightweight (nginx or `serve`), since you don't want the whole Node toolchain in your final image:

```dockerfile
# frontend/Dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

Minimal `docker-compose.yml` at the repo root:

```yaml
services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
  frontend:
    build: ./frontend
    ports:
      - "5173:80"
    depends_on:
      - backend
```

**Verify:** `docker compose up --build`, open the frontend in your browser, confirm it can actually reach the backend. This is where the classic bug shows up: the frontend calling `http://localhost:3000` works on your machine locally but **fails inside Docker**, because `localhost` inside the frontend *container* means the frontend container itself, not the backend one. Fix: the frontend's API base URL needs to be the backend's **service name** (`http://backend:3000`) when running in compose — but that's only reachable from server-side code, not from JS running in the *browser* (the browser is on your host, outside the compose network, so it still needs `http://localhost:3000`, since you've published that port to the host). For a plain client-side React app hitting the API from the browser, `localhost:3000` is actually correct as long as you've mapped the port — the `backend:3000` service-name trick only matters for container-to-container calls (which you don't have here, but would if you ever added a server-side proxy). Confirm this once now, in writing in your README, so you're not confused by it again at Layer 5.

Commit both Dockerfiles + compose file once this round-trip works: `git commit -m "Add Docker setup for backend and frontend, verified end-to-end"`.

### Step C — From here on: check Docker once per checkpoint, not per change

| After checkpoint | Docker action | What to confirm |
|---|---|---|
| v0.2 (validation) | `docker compose up --build` | Bad-input requests still get rejected correctly through the containerized backend, not just locally |
| v0.3 (transfers) | `docker compose up --build` | A transfer through the containerized app updates both accounts correctly |
| v0.4 (optional extras) | `docker compose up --build` | Whatever you added still renders/works through the frontend container |
| v1.0 (final) | `docker compose up --build` from a **fresh clone** of your repo (delete local `node_modules`/`ledger.db` first, or clone into a new folder) | This is the real test — it proves a grader pulling your repo cold and running `docker compose up` gets a working app, which is exactly what they'll do |

Between these checkpoints, ignore Docker entirely and just run things locally. The SQLite file living inside the backend container is fine to let reset between rebuilds during development (you're not persisting real data) — only worry about a named volume for `ledger.db` if you want demo data to survive a `docker compose down`, which is a nice-to-have, not a requirement.

---

## 4. Layers 2–5 — Building On Top (schema unchanged from here on)

### Layer 2 — Polish & stricter validation (~1–1.5 hrs)
- **Problem:** Layer 1's validation is minimal; a grader poking at your API with bad input can break it.
- **Decisions:** centralize validation (one small `validateEntry()` function used by the route) vs. inline checks scattered per-route. *Chosen:* centralize — one place to read, one place to fix, easy to point to in review.
- **Add:** consistent error response shape (`{ error: "message" }` + correct HTTP status every time), max amount sanity limit, trim/require non-empty `name`/`description`.
- **Test:** re-run the full Layer 1 validation checklist against every new rule you add.
- **Checkpoint:** `git tag v0.2` — "hardened validation + consistent error handling."

### Layer 3 — Transfers (~1 hr)
- **Problem:** a transfer is really two entries (debit A, credit B) that must both succeed or both fail — if your code crashes between the two writes, you get a corrupted half-transfer.
- **Decision — atomicity:** wrap both inserts in a single SQLite transaction (`db.transaction(() => { ... })()` in `better-sqlite3`).
  - *Upside:* if the second insert throws, the first is automatically rolled back — no partial state, ever.
  - *Downside:* none real here — this is a case where the "correct" choice is also the easy one, which is worth explicitly noting in your README (not every trade-off is a real trade-off).
  - *Alternative rejected:* two separate `POST /entries` calls from the frontend with no DB transaction — fast to build, but a crash mid-way leaves money "created from nowhere" or "destroyed." Explain in your write-up why you rejected this.
- **New endpoint:** `POST /transfers` `{ fromAccountId, toAccountId, amount, description }`.
- **Test:** kill the server (or throw a forced error) mid-transfer in a test run and confirm neither entry was written — proves atomicity, don't just assume it.
- **Checkpoint:** `git tag v0.3` — "atomic transfers between accounts."

### Layer 4 — Optional depth, only if time allows (~1 hr)
- Filter entries by date range / type (query params on `GET /entries`).
- Seed script for demo data (makes your submission look alive on first run, not empty).
- **Decision if you attempt stored balance:** revisit the Layer 1 decision — add a `balance` column updated inside the same SQLite transaction as each entry insert, purely as a read-speed optimization, keep the computed version as a way to *verify* the stored one matches (a cheap internal consistency check). This is genuinely optional — skip it entirely if time is tight; computed balance is already correct.
- **Checkpoint:** `git tag v0.4` if reached — otherwise skip straight to Layer 5.

### Layer 5 — Final Docker Check + Documentation (not optional, do this even if Layers 4/3 get cut)
- **Docker:** by this point you've already been building and checking Docker incrementally per section 3.6 — this layer is just the **final fresh-clone verification** row from that table, plus a last look at your `docker-compose.yml` for anything hardcoded to your local machine (absolute paths, your own IP, etc).
- **README must include:** short description, tech stack, setup/run instructions (`docker compose up`), architecture explanation (frontend↔backend↔SQLite), and the inner-workings explanation (the decisions above — integer cents, computed balance, transaction-wrapped transfers, and the `localhost` vs service-name note from 3.6 if it tripped you up).
- **Checkpoint / final:** `git tag v1.0` — this is your actual submission.

---

## 5. Git Workflow Note

Commit at the end of *each* checklist section above, not just at each checkpoint tag — "add validation for negative amounts," "add running balance to entries endpoint," etc. Small, named commits are literally what "meaningful commits showing development progress" (a submission requirement) is asking for, and they cost you nothing extra since you're already working in these discrete steps.

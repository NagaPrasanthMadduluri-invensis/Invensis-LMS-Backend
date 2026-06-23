# TMS / LMS Backend

Express + Drizzle ORM + PostgreSQL 18 API server. Built to `TMS_LMS_Technical_Architecture_v1.0.pdf` (with the agreed overrides). This first slice implements **authentication with roles**.

## Setup

```bash
npm install
cp .env.example .env          # then edit secrets / DATABASE_URL
npm run db:generate           # generate SQL migration from src/db/schema.js
npm run db:migrate            # apply migration (creates uuidv7() — requires PG 18)
npm run db:seed               # one user per role (password: Password123!)
npm run dev                   # http://localhost:5000
```

> Requires **PostgreSQL 18** (uses native `uuidv7()` for primary keys).

## Auth API

Dual-token JWT (§5.1, §9.1): a 15-min **access token** (returned in the JSON body, sent as `Authorization: Bearer`) and a 7-day **refresh token** (httpOnly cookie, scoped to `/api/auth`).

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Email + password → access token + refresh cookie |
| POST | `/api/auth/refresh` | refresh cookie | Rotates refresh token, issues new access token |
| POST | `/api/auth/logout` | refresh cookie | Revokes (denylists) the refresh token |
| GET | `/api/auth/me` | Bearer access | Current user |

### Seed accounts

`admin@`, `trainer@`, `sponsor@`, `learner@` `invensis.test` — all password `Password123!`.

## Roles

`users.role` enum: `admin | trainer | sponsor | learner`. Guard routes with
`requireRole(...roles)` (in `src/middleware/require-role.js`) after `verifyToken`.

## Session invalidation

- **Logout / rotation** → refresh token `jti` added to a denylist
  (`src/lib/token-store.js` — Postgres-backed, swappable to Redis).
- **Kill all sessions** for a user → increment `users.token_version`.

## Layout

```
src/
├── index.js                  # app wiring
├── config/{env,db}.js        # env validation + Drizzle pool
├── db/{schema,seed}.js       # Drizzle schema + seed
├── lib/                      # jwt, password, token-store, errors, async-handler
├── middleware/               # verify-token, require-role, rate-limit, error-handler
└── modules/auth/             # routes → controller → service → schema (Zod)
```

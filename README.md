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

## Deploying

`deploy.sh` pulls, installs, runs `db:migrate`, restarts under pm2 and health-checks. Two guards run before anything is applied: **schema drift** (the committed schema must match the database) and **un-ledgered objects** (nothing in the database that no migration created).

**No environment variables are required beyond those already in `src/config/env.js`.** Adding a column or an API field never needs new config; only a genuinely new integration would. Check by looking for new `process.env.*` reads in the diff — if there are none, `.env` needs no change.

Migrations are the thing that does need attention: they are applied automatically by `deploy.sh`, but a migration that only exists on a developer's machine will trip the schema-drift guard on the next deploy. Confirm the `drizzle/*.sql` files and `drizzle/meta/_journal.json` are committed before deploying.

### Migrations that alter existing data

Most migrations only add a column and are safe to re-run on any environment. These do more, and are worth knowing about when deploying to an environment that already has data:

| Migration | Effect |
|---|---|
| `0029_learner_employment_status` | Adds `user_profiles.employment_status`. Existing rows are `null`, which is treated as **employed** — requirements for existing profiles are unchanged. |
| `0030_user_last_login` | Adds `users.last_login_at`. **Cannot be back-filled**: the data was never recorded, so every account reads "Never" until its next sign-in. |
| `0031_training_status_default_active` | Changes the `training_ids.status` default from `pending` to `active` **and updates existing `pending` rows to `active`**. Only confirmed orders reach this platform, so no code path ever assigned `pending`; the value stays in the enum (Postgres cannot drop an enum value) but is no longer reachable. |

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

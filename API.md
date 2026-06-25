# TMS / LMS API — Frontend Integration Guide

Contract for the endpoints implemented so far. All examples reflect the **actual verified responses**.

- **Base URL:** `http://localhost:5000/api` (dev). Configure in the frontend as `NEXT_PUBLIC_API_URL` (e.g. `http://localhost:5000/api`).
- **Content type:** requests and responses are JSON (`Content-Type: application/json`).

---

## 1. Conventions

### 1.1 The two tokens (read this first)

Authentication uses a **dual-token** model:

| Token | Lifetime | Where it lives | How the frontend uses it |
|---|---|---|---|
| **Access token** | 15 min | Returned in the JSON body. **Store in memory** (React state / context) — *never* localStorage. | Send as `Authorization: Bearer <accessToken>` on protected requests. |
| **Refresh token** | 7 days | **httpOnly cookie** `refresh_token`, scoped to path `/api/auth`. | You can't read or set it from JS. The browser sends it automatically to `/api/auth/refresh` and `/api/auth/logout` — **only if you set `credentials: "include"`**. |

**Consequences for the frontend:**
- Every request that should carry the refresh cookie (`login`, `refresh`, `logout`) **must** use `credentials: "include"` (fetch) / `withCredentials: true` (axios).
- The access token is short-lived. When a protected call returns **401**, call `POST /api/auth/refresh` once, then retry the original request. If refresh also fails, treat the user as logged out.
- The refresh token **rotates** on every refresh: the old one is immediately revoked. Never cache/replay an old refresh response.

### 1.2 Error shape

All errors return JSON with a `message`:

```json
{ "message": "Invalid email or password" }
```

Validation errors (422) additionally include a per-field `errors` map (matches Zod's `fieldErrors`):

```json
{
  "message": "Validation failed",
  "errors": { "email": ["Invalid email"], "password": ["Password is required"] }
}
```

### 1.3 Status codes

| Code | Meaning |
|---|---|
| `200` | Success (with body) |
| `204` | Success, no body (logout) |
| `401` | Not authenticated / bad credentials / invalid/expired/revoked token |
| `403` | Authenticated but not allowed (inactive account, role not permitted, or no enrolment/assignment for this record) |
| `404` | Resource not found |
| `409` | Conflict (e.g. that trainer is already assigned) |
| `422` | Validation failed (see `errors`), or a business rule blocked it (e.g. min-seats on meeting release) |
| `429` | Rate limit hit (applies to `login` and `refresh`: 20 requests / 15 min per IP) |
| `500` | Unexpected server error |

### 1.4 The `user` object

Returned by `login`, `refresh`, and `me`. This is the full public shape (no secrets):

```json
{
  "id": "019ef342-9bf4-7e51-8f23-2b6f3dfee23f",
  "name": "Admin User",
  "email": "admin@invensis.test",
  "role": "admin",
  "isActive": true
}
```

`role` is one of: **`admin` · `trainer` · `sponsor` · `learner`** — use it to gate UI and route the user to the correct portal.

---

## 2. Endpoints

### 2.1 `POST /api/auth/login`

Authenticate with email + password.

- **Auth:** none
- **Credentials:** `include` (to receive the refresh cookie)
- **Body:**
  ```json
  { "email": "admin@invensis.test", "password": "Password123!" }
  ```
- **`200` response** (and sets the `refresh_token` httpOnly cookie):
  ```json
  {
    "user": { "id": "019ef3...", "name": "Admin User", "email": "admin@invensis.test", "role": "admin", "isActive": true },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
- **Errors:** `401` invalid credentials · `403` inactive account · `422` bad body · `429` too many attempts

### 2.2 `POST /api/auth/refresh`

Exchange the refresh cookie for a new access token (and a rotated refresh cookie).

- **Auth:** the `refresh_token` cookie (sent automatically by the browser)
- **Credentials:** `include` (required — otherwise the cookie isn't sent)
- **Body:** none
- **`200` response** (same shape as login; sets a new `refresh_token` cookie):
  ```json
  {
    "user": { "id": "019ef3...", "name": "Admin User", "email": "admin@invensis.test", "role": "admin", "isActive": true },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
- **Errors:** `401` if the cookie is missing, expired, revoked (e.g. already rotated or logged out), or the account is inactive.

### 2.3 `POST /api/auth/logout`

Revoke the current refresh token and clear the cookie.

- **Auth:** the `refresh_token` cookie
- **Credentials:** `include`
- **Body:** none
- **`204` response:** empty body; the `refresh_token` cookie is cleared. Always succeeds (idempotent — even an already-invalid token returns 204). After this, clear the in-memory access token client-side.

### 2.4 `GET /api/auth/me`

Get the currently authenticated user.

- **Auth:** `Authorization: Bearer <accessToken>`
- **`200` response:**
  ```json
  { "user": { "id": "019ef3...", "name": "Admin User", "email": "admin@invensis.test", "role": "admin", "isActive": true } }
  ```
- **Errors:** `401` missing/invalid/expired access token · `404` user no longer exists

### 2.5 `GET /api/health`

Liveness check. No auth.

- **`200` response:** `{ "status": "ok", "timestamp": "2026-06-23T06:53:48.022Z" }`

---

## 3. Training, admin & trainer endpoints

§3.1–3.3 require a **Bearer access token** and are **role-gated** (with extra ownership checks noted per endpoint). §3.4 (`POST /api/orders`) is a machine integration and uses **HMAC request signing** instead — no user token.

### 3.1 `GET /api/learner/training/:trainingId`

Full training detail for the authenticated **learner**, who must have a **confirmed enrolment** in this training.

- **Auth:** Bearer access token · role `learner`
- **`200` response:**
  ```json
  {
    "training_id": "TRN-2026-0001",
    "title": "PMP Certification Training",
    "delivery_mode": "virtual",
    "bucket": "direct_online",
    "status": "active",
    "trainer": { "name": "Trainer User", "bio": "PMP-certified trainer", "experience": "10 years" },
    "sessions": [
      {
        "day_number": 1,
        "planned_topics": "Intro to PMP, framework, process groups",
        "start_time": "2026-09-15T03:30:00.000Z",
        "end_time": "2026-09-15T11:30:00.000Z",
        "status": "scheduled"
      }
    ],
    "days_left": 83,
    "meeting": { "url": "https://zoom.us/j/123456789", "platform": "zoom" }
  }
  ```
- **Field notes (important for rendering):**
  - `trainer` is `null` until an admin assigns one.
  - `meeting` is **omitted entirely** unless the admin has released the link. If the key is absent, don't render a join button.
  - `days_left`: whole days to the first upcoming session; `0` if `status` is `ongoing`; `null` if `completed`/`cancelled`.
  - `sessions` are ordered by `day_number`; `planned_topics` may be `null`. (There is no session `title`.)
  - timestamps are ISO‑8601 UTC.
- **Errors:** `401` no/invalid token · `403` not a learner **or** not enrolled in this training · `404` training not found

### 3.2 `PATCH /api/admin/trainings/:trainingId`

Admin action. Two **independent, both-optional** operations in one call — send whichever fields apply (at least one required).

- **Auth:** Bearer access token · role `admin`
- **Body:**
  ```json
  {
    "trainer_id": "019ef7fe-e439-792e-ac20-9a4ff91bbfb6",
    "meeting_url": "https://zoom.us/j/123456789",
    "meeting_platform": "zoom",
    "meeting_released": true
  }
  ```
  - `trainer_id` — assigns a trainer; the previous active assignment is closed (history preserved).
  - `meeting_url` / `meeting_platform` (`zoom` \| `teams` \| `other`) / `meeting_released` — set/update the meeting link.
- **Release rule:** setting `meeting_released: true` requires confirmed-enrolment count ≥ the training's `min_seats`, unless `min_seats_override` is set — otherwise `422`.
- **`200` response:**
  ```json
  {
    "training": {
      "id": "019ef7fe-e436-7c06-89b9-8cb925fd86c0",
      "code": "TRN-2026-0001",
      "title": "PMP Certification Training",
      "status": "active",
      "enrolled_count": 0,
      "min_seats": 1,
      "min_seats_override": false,
      "meeting_url": "https://zoom.us/j/123456789",
      "meeting_platform": "zoom",
      "meeting_released": true,
      "meeting_triggered_at": "2026-06-24T04:59:19.151Z"
    }
  }
  ```
- **Errors:** `400` trainer not found/inactive · `409` that trainer is already assigned · `422` min-seats not met or invalid body · `404` training not found · `403` not an admin

### 3.3 `PATCH /api/trainer/sessions/:sessionId/topics`

Lets the **assigned trainer** set/update a session's planned topics.

- **Auth:** Bearer access token · role `trainer` · must be the currently-assigned trainer for the session's training
- **Body:**
  ```json
  { "planned_topics": "Intro to PMP, framework, process groups" }
  ```
- **`200` response:**
  ```json
  { "session": { "id": "019ef7fe-e438-770a-acf8-a1cce142d198", "day_number": 1, "planned_topics": "Intro to PMP, framework, process groups" } }
  ```
- **Errors:** `403` not a trainer / not assigned to this training · `404` session not found · `422` empty body

### 3.4 `POST /api/orders`

Ingest a **confirmed CRM order** → creates/links the schedule, Training ID, sessions, participants, and enrolments.

> **Server-to-server / integration endpoint** — called by the CRM (or a service), *not* by the browser frontend. Authenticated with an **HMAC signature**, not a user token.

- **Auth:** HMAC-SHA256 signature (no login/JWT). Send `X-Signature: sha256=<hex>`, where `<hex>` = `HMAC_SHA256(rawBody, ORDER_HMAC_SECRET)` (a secret shared with the CRM). The server recomputes the HMAC over the exact received body and compares it timing-safely.
- **Body:** the confirmed `order.paid` payload (see `crm_api.md` §3). Consumed fields:
  - `order_id` (string) — also the **idempotency key**
  - `order.payment_status` — must be `"paid"` (otherwise `422`); `order.purchase_type` derives the bucket
  - `course.course_name`
  - `learners[]` — each requires `email` (plus optional name/phone)
  - `schedule` — `schedule_id`, `start_date`, `end_date`, `start_time`, `end_time`, `session_dates[]` (plus optional `batch_type`, `delivery_format`, `venue`, `timezone`, …)
  - Extra fields are accepted and stored for traceability.
- **Signing example (Node):**
  ```js
  import crypto from "node:crypto";
  const body = JSON.stringify(order);            // the exact bytes you will send
  const sig = "sha256=" + crypto
    .createHmac("sha256", process.env.ORDER_HMAC_SECRET)
    .update(body)
    .digest("hex");
  // fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body })
  ```
  > Sign the **exact raw bytes** you send. Re-serializing differently on each side will make the signature mismatch.
- **Behavior:** **idempotent** — creates or reuses the schedule + Training ID (`TRN-YYYY-NNNN`) + day-wise sessions, upserts participants by email, and inserts confirmed enrolments. Re-posting the same order changes nothing.
- **`201` response:**
  ```json
  {
    "result": {
      "order_id": "INV-20260608-TEST01",
      "schedule_code": "INL000099",
      "training_id": "019ef853-bb51-7237-a97b-207b031d4be0",
      "training_code": "TRN-2026-0002",
      "training_created": true,
      "participants": 1,
      "new_enrolments": 1,
      "enrolled_count": 1
    }
  }
  ```
- **Errors:** `401` missing/invalid signature · `422` `payment_status` not `paid`, or invalid body

---

## 4. Frontend integration

### 4.1 Recommended flow

1. **Login** → store `user` and `accessToken` in memory (e.g. auth context). The refresh cookie is set automatically.
2. **Protected calls** → attach `Authorization: Bearer <accessToken>`.
3. **On 401** → call `refresh` once; on success, update the in-memory access token and retry; on failure, route to login.
4. **App load / page refresh** → access token is gone (memory only), so call `refresh` to silently restore the session; if it 401s, the user is logged out.
5. **Logout** → call `logout`, then clear in-memory state and redirect to login.

### 4.2 fetch example

```js
const API = process.env.NEXT_PUBLIC_API_URL; // http://localhost:5000/api

export async function login(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include", // receive the refresh cookie
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await res.json(); // { message, errors? }
  return res.json(); // { user, accessToken }
}

export async function refresh() {
  const res = await fetch(`${API}/auth/refresh`, {
    method: "POST",
    credentials: "include", // send the refresh cookie
  });
  if (!res.ok) throw await res.json();
  return res.json(); // { user, accessToken }
}
```

### 4.3 axios interceptor (auto-refresh on 401)

The spec uses Axios + TanStack Query. A single client with an interceptor handles refresh transparently:

```js
import axios from "axios";

let accessToken = null;                 // kept in memory
export const setAccessToken = (t) => { accessToken = t; };

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,                // always send/receive the refresh cookie
});

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retried) {
      original._retried = true;
      try {
        const { data } = await api.post("/auth/refresh");
        setAccessToken(data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);           // retry once
      } catch {
        setAccessToken(null);           // refresh failed → logged out
      }
    }
    return Promise.reject(error);
  }
);
```

> ⚠️ CORS: the backend allows the origin in `CORS_ORIGIN` (dev: `http://localhost:3000`) with `credentials: true`. The frontend origin must match exactly, and cross-origin requests **must** send credentials, or the refresh cookie will be silently dropped.

### 4.4 Gating by role

```js
const PORTAL_HOME = { admin: "/admin", trainer: "/trainer", sponsor: "/sponsor", learner: "/learner" };
router.push(PORTAL_HOME[user.role] ?? "/learner");
```

---

## 5. Dev seed accounts

> The training/admin/trainer endpoints (§3) need demo data — run `npm run db:seed:training` (after `db:seed`) to create a sample training (`TRN-2026-0001`) with sessions, a trainer profile, and an enrolled learner.

After `npm run db:seed`:

| Role | Email | Password |
|---|---|---|
| admin | `admin@invensis.test` | `Password123!` |
| trainer | `trainer@invensis.test` | `Password123!` |
| sponsor | `sponsor@invensis.test` | `Password123!` |
| learner | `learner@invensis.test` | `Password123!` |

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

`role` is one of: **`admin` · `trainer` · `sponsor` · `learner`**. Treat it as the user's **default landing portal** — but to decide *which features/nav to show*, use `capabilities` (next section), **not** `role` alone.

### 1.5 Capabilities & access (read this — important)

`login`, `refresh`, and `me` all return a **`capabilities`** object alongside `user`:

```json
"capabilities": { "admin": false, "trainer": false, "sponsor": true, "learner": true }
```

**Why it exists:** one account can be more than one thing. The most common case — a person buys a course **for themselves** — makes them both the **sponsor** (paid, sees invoices) *and* a **learner** (attends, sees course content). A single `role` can't express that, so we derive capability flags from the account's actual relationships:

| Flag | `true` when the account… | Grants (frontend) |
|---|---|---|
| `admin` | has the admin role | Admin TMS |
| `trainer` | has a trainer profile | Trainer portal (assigned sessions, attendance) |
| `sponsor` | is the **buyer** of ≥1 order | Sponsor portal (invoices/receipts, manage its learners) |
| `learner` | has ≥1 confirmed **enrolment** | Learner portal (course, sessions, meeting link, surveys, support) |

**How to use it:**
- **Route** to the default portal by `user.role` after login.
- **Render nav / guard sections** by `capabilities`, not `role`. Show a "Sponsor / Invoices" area whenever `capabilities.sponsor` is `true`, learner content whenever `capabilities.learner` is `true`, etc. A self-buyer (`role: "learner"` with `sponsor: true, learner: true`) then sees **both**.

**The `sponsor` field** (returned alongside `capabilities` on `login`/`refresh`/`me`): for a **learner**, this is *who paid for them* — the buyer of the order their enrolment came from — as `{ id, name, email }`:

```json
"sponsor": { "id": "019f16ee-...", "name": "Corp Sponsor", "email": "corp-sponsor@crm.test" }
```

It is **`null`** whenever there's no distinct sponsor: a **self-buyer** (you're your own sponsor — `sponsor:true, learner:true`), a **manually-added** learner (no order), or a **non-learner** (admin/trainer/sponsor-only). Use it on the learner portal to show "Sponsored by …". If a learner was enrolled via multiple sponsors, this is the most recent one.

**⚠️ Capabilities can change after login.** They are a **snapshot** computed at response time and are deliberately **not** baked into the access token (a learner can later become a sponsor by buying another seat; a new enrolment can arrive from the CRM mid-session). Therefore:
- Don't treat the login-time capabilities as permanent — they can grow/change.
- Re-read them whenever you refresh state: **every `refresh` and every `me` returns the current set.** Calling `GET /api/auth/me` on app load (and after actions that might change access) is the reliable way to stay current.
- You **cannot** infer capabilities by decoding the JWT — they aren't in it. Always read them from the response body.

**Security note:** these flags are a **UI convenience, not the security boundary.** The backend independently enforces access on every request (e.g. the learner training view re-checks enrolment ownership server-side). Hiding a button is not protection — unauthorized calls are still rejected with `401`/`403`.

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
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "capabilities": { "admin": true, "trainer": false, "sponsor": false, "learner": false },
    "sponsor": null
  }
  ```
- **Errors:** `401` invalid credentials · `403` inactive account · `422` bad body · `429` too many attempts

### 2.2 `POST /api/auth/refresh`

Exchange the refresh cookie for a new access token (and a rotated refresh cookie).

- **Auth:** the `refresh_token` cookie (sent automatically by the browser)
- **Credentials:** `include` (required — otherwise the cookie isn't sent)
- **Body:** none
- **`200` response** (same shape as login — incl. fresh `capabilities`; sets a new `refresh_token` cookie):
  ```json
  {
    "user": { "id": "019ef3...", "name": "Admin User", "email": "admin@invensis.test", "role": "admin", "isActive": true },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "capabilities": { "admin": true, "trainer": false, "sponsor": false, "learner": false },
    "sponsor": null
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
- **`200` response** (use this to refresh capabilities — see §1.5):
  ```json
  {
    "user": { "id": "019ef3...", "name": "Admin User", "email": "admin@invensis.test", "role": "admin", "isActive": true },
    "capabilities": { "admin": true, "trainer": false, "sponsor": false, "learner": false },
    "sponsor": null
  }
  ```
- **Errors:** `401` missing/invalid/expired access token · `404` user no longer exists

### 2.5 `POST /api/auth/forgot-password`

Request a password-reset link by email. **Always returns `200` with the same message** whether or not an account exists (no account enumeration). A reset link is emailed only when an active account with that email exists.

- **Auth:** none · rate-limited
- **Body:** `{ "email": "user@example.com" }`
- **`200` response:**
  ```json
  { "message": "If an account exists for that email, a reset link has been sent." }
  ```
- The emailed link points at `FRONTEND_URL/reset-password?token=<token>`. Your reset page reads `token` from the query string and submits it with the new password to §2.6.

### 2.6 `POST /api/auth/set-password`

Set a password using a token from an **account-setup** or **password-reset** email. Serves both links. On success the account is activated and any existing sessions are invalidated.

- **Auth:** none · rate-limited
- **Body:** `{ "token": "<from the email link>", "password": "min 8 chars" }`
- **`200` response:**
  ```json
  { "message": "Password set. You can now log in." }
  ```
- **Errors:** `422` validation (e.g. password shorter than 8 chars) · `400` `{ "message": "Invalid or expired token" }` (unknown, expired, or already-used token). Tokens are **single-use** and valid for 72 hours.

> **New accounts have no password until setup.** Accounts created by the system — CRM order learners & sponsors (§3.4), admin-added participants (§3.2.4), and admin-onboarded trainers without a supplied password (§3.2.5) — are created **active but with no password**. They **cannot log in** (login returns `401`) until the user follows the setup email (`FRONTEND_URL/set-password?token=…`) and sets one via §2.6.

### 2.7 `GET /api/health`

Liveness check. No auth.

- **`200` response:** `{ "status": "ok", "timestamp": "2026-06-23T06:53:48.022Z" }`

---

## 3. Training, admin & trainer endpoints

§3.1–3.3 require a **Bearer access token**. Most are **role-gated**, but some are **relationship-scoped** instead — e.g. `GET /api/learner/trainings` (§3.1) returns only the caller's own enrolments, so any authenticated user may call it (extra ownership checks are noted per endpoint). §3.4 (`POST /api/orders`) is a machine integration and uses **HMAC request signing** instead — no user token.

### 3.1.0 `GET /api/learner/dashboard`

Single overview snapshot for the learner landing page: profile summary, progress stats, a chronological learning journey, the learner's enrolments grouped by lifecycle, certificates earned, and **upcoming cohorts open to register for** (a nudge to enrol).

- **Auth:** Bearer access token. **Not role-gated** — scoped to the caller's own enrolments (same as §3.1), so any authenticated user gets their journey plus the marketing cohort list. A user with no enrolments gets zeroed stats and empty lists (but still sees `upcoming_cohorts`).
- **`200` response:**
  ```json
  {
    "generated_at": "2026-07-10T07:37:05.207Z",
    "learner": {
      "id": "019f03c1-936c-7cba-9a23-289b54773423",
      "name": "Learner User",
      "email": "learner@invensis.test",
      "avatar_url": null,
      "job_title": null,
      "company_name": null,
      "country": null,
      "member_since": "2026-06-26T11:47:25.676Z"
    },
    "stats": {
      "total_enrolments": 1,
      "in_progress": 0,
      "upcoming": 1,
      "completed": 0,
      "certificates_earned": 0,
      "learning_hours": 0,
      "completion_rate": 0
    },
    "my_courses": {
      "in_progress": [],
      "upcoming": [
        {
          "id": "019f03c1-95ea-7cf3-bf75-f3c688a8f0cf",
          "code": "TRN-2026-0001",
          "title": "PMP Certification Training",
          "delivery_mode": "virtual",
          "bucket": "direct_online",
          "status": "active",
          "enrolment_status": "confirmed",
          "start_date": "2026-09-15",
          "end_date": "2026-09-18",
          "timezone": "Asia/Kolkata",
          "duration_hours": 32,
          "enrolled_at": "2026-06-26T11:47:26.323Z",
          "total_sessions": 4,
          "completed_sessions": 0,
          "progress_pct": 0,
          "days_until_start": 67,
          "meeting_released": false
        }
      ],
      "completed": []
    },
    "certificates": [],
    "journey": [
      {
        "type": "enrolled",
        "date": "2026-06-26T11:47:26.323Z",
        "training_code": "TRN-2026-0001",
        "title": "PMP Certification Training"
      }
    ],
    "upcoming_cohorts": [
      {
        "schedule_id": "019f03c1-95e8-7165-9f27-305941405638",
        "title": "PMP Certification Training",
        "bucket": "direct_online",
        "delivery_mode": "virtual",
        "batch_type": "weekday",
        "duration_hours": 32,
        "start_date": "2026-09-15",
        "end_date": "2026-09-18",
        "start_time": "09:00:00",
        "end_time": "17:00:00",
        "timezone": "Asia/Kolkata",
        "capacity": 20,
        "seats_left": 16,
        "starts_in_days": 67,
        "filling_fast": false,
        "is_full": false
      }
    ]
  }
  ```
- **`stats`** — `completion_rate = completed / total_enrolments` (0–1). `learning_hours` sums `duration_hours` across completed trainings. `certificates_earned` equals the length of `certificates`.
- **`my_courses`** — the caller's enrolments (cancelled/transferred excluded), split into `in_progress` (training `ongoing`), `upcoming` (not yet started), and `completed`. Each card carries `progress_pct` (`completed_sessions / total_sessions`, or `100` once finished) and `days_until_start` (`0` while ongoing).
- **`certificates`** — one entry per finished training (enrolment or training marked `completed`, e.g. via §3.2.9a/§3.2.9b). There is **no dedicated certificate store yet**, so this is derived from completed enrolments. Each entry carries the data a certificate is printed from: `training_code`, `title` (course name), `duration_hours`, and the scheduled `start_date`/`end_date` (the "from/to" range); `completed_at` is the enrolment's last-updated time (falls back to the schedule end date). `eligible` is `true` (completion grants eligibility); `downloadable` is a forward-looking flag currently always `false` — actually downloading the certificate will later be gated on the learner finishing the feedback + survey forms, and certificate PDF generation itself is not built yet.
- **`journey`** — a chronological (oldest → newest) timeline of `enrolled` / `completed` milestones for rendering a progress trail.
- **`upcoming_cohorts`** — up to 8 **active** offerings starting today or later that the learner is **not already enrolled in**, ordered by soonest start. `seats_left` = capacity − enrolled; `filling_fast` is `true` when ≤25% of seats remain, `is_full` when none do. Use these to drive "Register now" / "Filling fast" calls-to-action.
- **Errors:** `401` no/invalid token

### 3.1 `GET /api/learner/trainings`

The authenticated user's **"My Courses"** list — every training they're enrolled in. Enrolments are attached to the account automatically the moment the learner is enrolled (CRM order, admin add, or transfer), so this is how an assigned schedule shows up in their account.

- **Auth:** Bearer access token. **Not role-gated** — scoped to the caller's own enrolments, so a user whose landing `role` is `sponsor` but who also attends still sees their courses. Returns an empty list for users with no enrolments.
- Cancelled and transferred enrolments are excluded.
- **`200` response:**
  ```json
  {
    "trainings": [
      {
        "id": "019ef853-bb51-7237-a97b-207b031d4be0",
        "code": "TRN-2026-0002",
        "title": "PRINCE2 Foundation",
        "delivery_mode": "virtual",
        "status": "active",
        "start_date": "2026-10-10",
        "end_date": "2026-10-11",
        "timezone": "Asia/Kolkata",
        "enrolment_status": "confirmed",
        "meeting_released": false,
        "enrolled_at": "2026-06-24T06:31:37.542Z"
      }
    ]
  }
  ```
  Ordered by most recently enrolled. `meeting_released` tells the UI whether the meeting link is available yet; fetch the full detail (incl. the link, sessions, trainer) via §3.1.1.
- **Errors:** `401` no/invalid token

### 3.1.1 `GET /api/learner/training/:trainingRef`

Full training detail for the authenticated **learner**, who must have a **confirmed enrolment** in this training. `:trainingRef` may be the training **UUID** or its human **code** (e.g. `TRN-2026-0001`).

- **Auth:** Bearer access token · role `learner`
- **`200` response:**
  ```json
  {
    "training_id": "TRN-2026-0001",
    "title": "PMP Certification Training",
    "delivery_mode": "virtual",
    "bucket": "direct_online",
    "status": "active",
    "duration_hours": 32,
    "capacity": 20,
    "min_seats": 1,
    "enrolled_count": 0,
    "batch_type": "weekday",
    "timezone": "Asia/Kolkata",
    "start_date": "2026-09-15",
    "end_date": "2026-09-18",
    "start_time": "09:00:00",
    "end_time": "17:00:00",
    "session_dates": ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"],
    "venue": null,
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
  - The schedule block (`duration_hours`, `batch_type`, `timezone`, `start_date`/`end_date`, `start_time`/`end_time`, `session_dates`, `venue`) comes from the linked **schedule offering**; these are `null` when the training has no linked schedule (manually-created). `capacity`/`min_seats` fall back to the training-level values in that case.
  - `start_date`/`end_date` are `YYYY-MM-DD`; `start_time`/`end_time` are local `HH:MM:SS` daily-window times to be read in `timezone`. `venue` is `null` for virtual delivery.
  - `trainer` is `null` until an admin assigns one.
  - `meeting` is **omitted entirely** unless the admin has released the link. If the key is absent, don't render a join button.
  - `days_left`: whole days to the first upcoming session; `0` if `status` is `ongoing`; `null` if `completed`/`cancelled`.
  - `sessions` are ordered by `day_number`; `planned_topics` may be `null`. (There is no session `title`.) Session `start_time`/`end_time` are ISO‑8601 UTC timestamps.
- **Errors:** `401` no/invalid token · `403` not a learner **or** not enrolled in this training · `404` training not found

### 3.1.2 `GET /api/learner/certificates`

The caller's **training certificates** — one per completed enrolment. A learner becomes **eligible** for a certificate once an admin marks their enrolment `completed` (§3.2.9a/§3.2.9b). Actually **downloading** it is gated on the learner submitting the post-training feedback survey (§3.1.3), which **issues** the certificate. Scoped to the caller's own enrolments — **not role-gated** (like §3.1.0/§3.1).

- **Auth:** Bearer access token
- **`200` response:**
  ```json
  {
    "certificates": [
      {
        "training_id": "019f03c1-95ea-7cf3-bf75-f3c688a8f0cf",
        "training_code": "TRN-2026-0001",
        "title": "PMP Certification Training",
        "delivery_mode": "virtual",
        "start_date": "2026-09-15",
        "end_date": "2026-09-18",
        "participant_name": "Learner User",
        "activity_id": "INL000006",
        "certificate_id": "INVLZR7924",
        "issued": true,
        "issued_at": "2026-07-10T11:36:11.755Z",
        "completed_at": "2026-07-10T10:41:03.597Z"
      }
    ]
  }
  ```
- **Field notes (these are the values printed on the certificate):**
  - `title` — the course name.
  - `start_date`/`end_date` — the scheduled date range ("which took place …"). Delivery mode drives the "via …" phrase.
  - `participant_name` — the learner's name.
  - `activity_id` — the linked **schedule event code** (e.g. `INL000006`), looked up from the training. Falls back to the training code when the training has no linked schedule.
  - `certificate_id` — the generated, stable certificate code (e.g. `INVLZR7924`); **`null` until issued**.
  - `issued` — `true` once the feedback survey has been submitted (the certificate is unlocked/downloadable). `issued_at` is when that happened.
- **Errors:** `401` no/invalid token

### 3.1.3 `POST /api/learner/certificates/:trainingRef/survey`

Submit the **post-training feedback survey**, which **issues (unlocks)** the certificate. Requires a **completed** enrolment owned by the caller. **Idempotent** — if already issued, the existing certificate is returned unchanged (the first survey stands). `:trainingRef` accepts the training UUID or code.

- **Auth:** Bearer access token
- **Body:**
  ```json
  { "overall_rating": 5, "trainer_rating": 5, "content_rating": 4, "would_recommend": true, "comments": "Great sessions" }
  ```
  Ratings are integers `1`–`5` (all three required); `would_recommend` is a boolean (required); `comments` is optional (≤2000 chars).
- **`201` response:** `{ "certificate": { …same shape as §3.1.2, now issued } }`
- **Errors:** `403` not eligible (no completed enrolment for this training, or not the caller's) · `422` invalid survey body · `401` no/invalid token

### 3.1.4 `GET /api/learner/certificates/:trainingRef`

Full data for **one** certificate, for rendering the printable/downloadable document. `:trainingRef` accepts the UUID or code.

- **Auth:** Bearer access token
- **`200` response:** `{ "certificate": { …same shape as §3.1.2 } }`
- **Errors:** `403` not eligible, **or** eligible but the survey hasn't been submitted yet (`"Complete the feedback survey to unlock your certificate"`) · `401` no/invalid token

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
- **Note:** `:trainingId` accepts the training **UUID or code** (e.g. `TRN-2026-0001`).

### 3.2.0 `GET /api/admin/dashboard`

Single overview snapshot for the admin dashboard landing page. Aggregates users, trainers, courses (Training IDs), enrolments, certificates and (placeholder) support tickets, plus a few preview lists.

- **Auth:** Bearer access token · role `admin`
- **`200` response:**
  ```json
  {
    "generated_at": "2026-07-10T07:05:39.772Z",
    "users": {
      "total": 7,
      "active": 7,
      "inactive": 0,
      "pending_setup": 0,
      "by_role": { "admin": 1, "trainer": 1, "sponsor": 1, "learner": 4 },
      "participants_total": 4
    },
    "trainers": {
      "total": 1,
      "active": 1,
      "inactive": 0,
      "assigned": 1,
      "unassigned": 0,
      "total_certificates": 0
    },
    "courses": {
      "total": 1,
      "by_status": { "pending": 0, "active": 1, "ongoing": 0, "completed": 0, "cancelled": 0 },
      "upcoming": 1,
      "ongoing": 0,
      "completed": 0,
      "meeting_released": 0,
      "total_capacity": 20,
      "total_enrolled": 4,
      "fill_rate": 0.2
    },
    "enrolments": {
      "total": 4,
      "confirmed": 4,
      "completed": 0,
      "cancelled": 0,
      "transferred": 0,
      "failed": 0
    },
    "certificates": {
      "issued": 0,
      "trainer_certificates": 0,
      "note": "Derived from completed enrolments; a dedicated certificate store is not yet implemented."
    },
    "tickets": {
      "supported": false,
      "total": 0,
      "open": 0,
      "in_progress": 0,
      "resolved": 0,
      "closed": 0,
      "note": "Support ticketing is not yet available; showing placeholder values."
    },
    "upcoming_trainings": [
      {
        "id": "019f03c1-95ea-7cf3-bf75-f3c688a8f0cf",
        "code": "TRN-2026-0001",
        "title": "PMP Certification Training",
        "status": "active",
        "delivery_mode": "virtual",
        "bucket": "direct_online",
        "capacity": 20,
        "enrolled_count": 4,
        "start_date": "2026-09-15",
        "end_date": "2026-09-18",
        "timezone": "Asia/Kolkata",
        "trainer_assigned": true,
        "trainer_name": "Trainer User"
      }
    ],
    "completed_trainings": [],
    "recent_enrolments": [
      {
        "enrolment_id": "019f12ac-fe15-7592-8de6-3baeaa171b1b",
        "status": "confirmed",
        "enrolled_at": "2026-06-29T09:19:14.656Z",
        "participant_name": "Priya Sharma",
        "participant_email": "priya.sharma@example.com",
        "training_code": "TRN-2026-0001",
        "training_title": "PMP Certification Training"
      }
    ],
    "recent_trainers": [
      {
        "id": "019f03c1-95ef-7992-82da-443ac54eca0d",
        "name": "Trainer User",
        "email": "trainer@invensis.test",
        "is_active": true,
        "created_at": "2026-06-26T11:47:26.319Z"
      }
    ]
  }
  ```
- **`users`** — `by_role` always includes all four roles (`0` when none). `pending_setup` counts accounts with no password yet (setup email pending). `participants_total` is the count of `participants` rows (learners on rosters).
- **`trainers`** — `assigned` counts trainers holding at least one **currently-active** assignment; `unassigned = total − assigned`. `total_certificates` sums each trainer's `certificates` array.
- **`courses`** — one row per Training ID. `upcoming` = scheduled to start today or later and not `cancelled`/`completed`. `fill_rate = total_enrolled / total_capacity` rounded to 2 dp (`0` when no capacity).
- **`certificates`** — there is **no dedicated certificate store yet**; `issued` is a proxy for completed enrolments. `trainer_certificates` mirrors `trainers.total_certificates`.
- **`tickets`** — **static placeholder** (`supported: false`, all counts `0`). Support ticketing is not built yet; swap for live counts when the feature lands.
- Preview lists (`upcoming_trainings` ≤ 8, `completed_trainings` ≤ 8, `recent_enrolments` ≤ 8, `recent_trainers` ≤ 5) are compact, ordered snapshots for dashboard widgets. Use §3.2.1 / §3.2.11 for full paginated lists.

### 3.2.1 `GET /api/admin/trainings`

Lists all Training IDs for the admin trainings view.

- **Auth:** Bearer access token · role `admin`
- **`200` response:**
  ```json
  {
    "trainings": [
      {
        "id": "019f03c1-95ea-7cf3-bf75-f3c688a8f0cf",
        "code": "TRN-2026-0001",
        "title": "PMP Certification Training",
        "status": "active",
        "delivery_mode": "virtual",
        "bucket": "direct_online",
        "capacity": 20,
        "enrolled_count": 2,
        "min_seats": 1,
        "start_date": "2026-09-15",
        "end_date": "2026-09-18",
        "duration_hours": 32,
        "timezone": "Asia/Kolkata",
        "meeting_url": "https://zoom.us/j/123456789",
        "meeting_platform": "zoom",
        "meeting_released": false,
        "trainer_assigned": true,
        "trainer_name": "Trainer User"
      }
    ]
  }
  ```
- `trainer_assigned` is `false` / `trainer_name` is `null` when no trainer is currently assigned.
- Meeting fields are shown to the admin **regardless of `meeting_released`** (`null` until a link is set). `meeting_released` reflects whether learners can see it.

### 3.2.2 `GET /api/admin/trainings/:trainingId`

Full admin detail for one training: schedule, the assigned trainer (if any), and every enrolled participant. `:trainingId` accepts the UUID or the code.

- **Auth:** Bearer access token · role `admin`
- **`200` response:**
  ```json
  {
    "id": "019f03c1-95ea-7cf3-bf75-f3c688a8f0cf",
    "training_id": "TRN-2026-0001",
    "title": "PMP Certification Training",
    "delivery_mode": "virtual",
    "bucket": "direct_online",
    "status": "active",
    "capacity": 20,
    "min_seats": 1,
    "enrolled_count": 2,
    "duration_hours": 32,
    "batch_type": "weekday",
    "timezone": "Asia/Kolkata",
    "start_date": "2026-09-15",
    "end_date": "2026-09-18",
    "start_time": "09:00:00",
    "end_time": "17:00:00",
    "session_dates": ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"],
    "venue": null,
    "meeting_url": "https://zoom.us/j/123456789",
    "meeting_platform": "zoom",
    "meeting_released": false,
    "meeting_triggered_at": "2026-06-24T04:59:19.151Z",
    "trainer": {
      "id": "019f03c1-95ef-7992-82da-443ac54eca0d",
      "name": "Trainer User",
      "email": "trainer@invensis.test",
      "bio": "PMP-certified trainer",
      "experience": "10 years",
      "assigned_at": "2026-06-29T09:10:00.000Z"
    },
    "participants": [
      {
        "enrolment_id": "019f12a4-bbab-707b-98fa-f4ff48ebafc6",
        "participant_id": "019f12a4-bbaa-71e7-b75c-331199b42e59",
        "name": "Manual Tester",
        "email": "manual.tester@example.com",
        "phone": "+91 90000 00000",
        "job_title": "QA Engineer",
        "status": "confirmed",
        "enrolled_at": "2026-06-29T09:10:13.354Z",
        "added_manually": true
      }
    ],
    "sessions": [
      {
        "id": "019ef7fe-e438-770a-acf8-a1cce142d198",
        "day_number": 1,
        "planned_topics": "Day 1: intro, framework",
        "start_time": "2026-09-15T03:30:00.000Z",
        "end_time": "2026-09-15T11:30:00.000Z",
        "status": "scheduled"
      }
    ]
  }
  ```
- `trainer` is `null` until assigned. `added_manually` is `true` for participants added by an admin (no linked CRM order). `sessions[]` shows the day-wise sessions with the `planned_topics` set by the trainer.
- **Errors:** `404` training not found · `403` not an admin

### 3.2.3 `GET /api/admin/trainers`

Lists active trainers for the assignment picker.

- **Auth:** Bearer access token · role `admin`
- **`200` response:**
  ```json
  { "trainers": [ { "id": "019f03c1-95ef-...", "name": "Trainer User", "email": "trainer@invensis.test", "bio": "PMP-certified trainer", "experience": "10 years" } ] }
  ```

### 3.2.4 `POST /api/admin/trainings/:trainingId/participants`

Manually enrol a participant in a training. Finds or creates the learner's user account + participant record, then inserts a confirmed enrolment and refreshes `enrolled_count`. `:trainingId` accepts the UUID or the code. A **newly created** account has no password and is emailed a setup link (see §2.6).

- **Auth:** Bearer access token · role `admin`
- **Body:**
  ```json
  { "name": "Jane Doe", "email": "jane@example.com", "phone": "+91 …", "job_title": "Project Manager" }
  ```
  `phone` and `job_title` are optional.
- **`201` response:**
  ```json
  {
    "participant": {
      "enrolment_id": "019f12a4-bbab-707b-98fa-f4ff48ebafc6",
      "participant_id": "019f12a4-bbaa-71e7-b75c-331199b42e59",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "phone": "+91 …",
      "job_title": "Project Manager",
      "status": "confirmed",
      "enrolled_at": "2026-06-29T09:10:13.354Z",
      "added_manually": true
    },
    "enrolled_count": 3
  }
  ```
- **Errors:** `409` participant already enrolled · `422` invalid body or training at full capacity · `404` training not found · `403` not an admin

### 3.2.5 `POST /api/admin/trainers`

Onboard a trainer — ensures a `users` account (role `trainer`) and creates the trainer profile. `password` is **optional**: if supplied, the trainer can log in immediately; if omitted, the new account has no password and is emailed a setup link (see §2.6).

- **Auth:** Bearer access token · role `admin`
- **Body:**
  ```json
  {
    "name": "New Trainer",
    "email": "trainer@example.com",
    "password": "S3tByAdmin!",
    "bio": "Cloud expert",
    "experience": "10 years",
    "rate": 1500,
    "certificates": [{ "title": "AWS SA", "issued_by": "AWS", "issued_date": "2025-01-01", "file_key": "..." }]
  }
  ```
  Only `name` + `email` are required; `password` (min 8), `bio`/`experience`/`rate`/`certificates` are optional. If `password` is omitted, the placeholder default is used. **`password` only applies when a new account is created** — if a user with that email already exists, their password is left unchanged (only the trainer profile is added).
- **`201` response:** `{ "trainer": { "id", "user_id", "name", "email", "bio", "experience", "rate", "certificates", "is_active" } }`
- **Errors:** `409` that user is already a trainer · `422` invalid body · `403` not an admin

### 3.2.6 `GET /api/admin/trainers/:trainerId`

Trainer profile + full assignment history.

- **Auth:** Bearer access token · role `admin`
- **`200` response:**
  ```json
  {
    "id": "019f172b-...", "user_id": "...", "name": "New Trainer", "email": "trainer@example.com",
    "bio": "...", "experience": "...", "rate": "1500", "certificates": [...], "is_active": true,
    "assignments": [
      { "training_id": "...", "code": "TRN-2026-0001", "title": "PMP …", "assigned_at": "…", "removed_at": null, "active": true }
    ]
  }
  ```
- **Errors:** `404` trainer not found · `403` not an admin

### 3.2.7 `PATCH /api/admin/trainers/:trainerId`

Edit a trainer / deactivate. Send any subset.

- **Auth:** Bearer access token · role `admin`
- **Body:** any of `name`, `bio`, `experience`, `rate`, `certificates`, `is_active` (at least one).
- **`200` response:** `{ "trainer": { ...updated } }`. Set `is_active: false` to stop a trainer being assignable (existing assignments are untouched).
- **Errors:** `404` trainer not found · `422` empty/invalid body · `403` not an admin

### 3.2.8 `PATCH /api/admin/participants/:participantId`

Edit a participant's details. **Email is not editable here** (it's the login identity); `name` is also synced to the linked account.

- **Auth:** Bearer access token · role `admin`
- **Body:** any of `name`, `phone`, `job_title` (at least one).
- **`200` response:** `{ "participant": { "id", "user_id", "name", "email", "phone", "job_title" } }`
- **Errors:** `404` participant not found · `422` empty/invalid body · `403` not an admin

### 3.2.9 `PATCH /api/admin/enrolments/:enrolmentId/cancel`

Cancel an enrolment (frees the seat, recomputes `enrolled_count`). **Reason required** and audited.

- **Auth:** Bearer access token · role `admin`
- **Body:** `{ "reason": "duplicate registration" }`
- **`200` response:** `{ "id": "...", "status": "cancelled" }`
- **Errors:** `409` already cancelled · `422` missing reason · `404` enrolment not found · `403` not an admin

### 3.2.9a `PATCH /api/admin/enrolments/:enrolmentId/complete`

Mark a single enrolment **completed** — the learner successfully finished the training. This is the **anchor for certificate eligibility**: once an enrolment is `completed`, the learner portal treats them as eligible for the certificate (see §3.1.0 `certificates`). **One-way** — only a `confirmed` enrolment can be completed, and it stays completed. Completion is **not** a seat event, so `enrolled_count` is left unchanged (unlike cancel/transfer). Audited.

- **Auth:** Bearer access token · role `admin`
- **Body:** none
- **`200` response:** `{ "id": "...", "status": "completed" }`
- **Errors:** `409` already completed · `422` not a confirmed enrolment (e.g. cancelled/transferred/failed) · `404` enrolment not found · `403` not an admin

### 3.2.9b `PATCH /api/admin/trainings/:trainingId/enrolments/complete-all`

Bulk **"mark all completed"** — flips **every currently-`confirmed`** enrolment in the training to `completed` in one call. Already-completed, cancelled, and transferred enrolments are skipped. `:trainingId` accepts the UUID or the code. Audited (one entry with the count). Does not change the training's own `status`.

- **Auth:** Bearer access token · role `admin`
- **Body:** none
- **`200` response:**
  ```json
  { "training_id": "TRN-2026-0001", "completed": 4 }
  ```
  `completed` is how many enrolments were actually flipped (`0` if none were confirmed).
- **Errors:** `404` training not found · `403` not an admin

### 3.2.10 `PATCH /api/admin/enrolments/:enrolmentId/transfer`

Move a participant to another training. Marks the source enrolment `transferred` and creates a new confirmed enrolment in the target (sponsor/order link preserved); recomputes both counts. **Reason required** and audited.

- **Auth:** Bearer access token · role `admin`
- **Body:** `{ "training_id": "TRN-2026-0002", "reason": "learner requested a different batch" }` (`training_id` accepts UUID or code)
- **`200` response:**
  ```json
  { "from_enrolment_id": "...", "to_enrolment_id": "...", "to_training": "TRN-2026-0002", "status": "transferred" }
  ```
- **Errors:** `409` not a confirmed enrolment, or already enrolled in target · `422` same training, target full, or missing reason · `404` enrolment/target not found · `403` not an admin

### 3.2.11 `GET /api/admin/participants`

List all participants for the admin dashboard — **paginated**, with optional **search** by name or email. Ordered by name.

- **Auth:** Bearer access token · role `admin`
- **Query params:** `search` (optional, matches name **or** email, case-insensitive) · `page` (default `1`) · `limit` (default `20`, max `100`)
- **`200` response:**
  ```json
  {
    "participants": [
      {
        "id": "019f11e8-0f96-7257-a93a-39500fa37a3a",
        "name": "Bob Learner",
        "email": "bob.learner@acme.test",
        "phone": "+10000000002",
        "job_title": "Project Manager",
        "enrolment_count": 1,
        "account_active": true,
        "has_password": true,
        "created_at": "2026-06-29T05:44:08.605Z"
      }
    ],
    "total": 16,
    "page": 1,
    "limit": 20
  }
  ```
  - `enrolment_count` — number of **confirmed** enrolments.
  - `account_active` — the linked user account's `is_active` (`false` if there's no linked account).
  - `has_password` — `false` means the account was auto-created and the user **hasn't completed setup yet** (setup email pending; see §2.6). Use this to flag "Setup pending" in the dashboard.
  - `total` is the count **before** pagination (use it with `page`/`limit` to render pagination controls).
- **Errors:** `422` invalid query params (e.g. `limit` > 100) · `401` no/invalid token · `403` not an admin

### 3.3.1 `GET /api/trainer/trainings`

Lists the trainings **currently assigned to the logged-in trainer** (derived from the JWT — no trainer id in the URL).

- **Auth:** Bearer access token · role `trainer`
- **`200` response:**
  ```json
  {
    "trainings": [
      {
        "id": "019ef7fe-e436-7c06-89b9-8cb925fd86c0",
        "code": "TRN-2026-0001",
        "title": "PMP Certification Training",
        "status": "active",
        "delivery_mode": "virtual",
        "bucket": "direct_online",
        "capacity": 20,
        "enrolled_count": 2,
        "start_date": "2026-09-15",
        "end_date": "2026-09-18",
        "timezone": "Asia/Kolkata"
      }
    ]
  }
  ```
  Returns only active assignments; empty list if the trainer has none.
- **Errors:** `401` no/invalid token · `403` not a trainer

### 3.3.2 `GET /api/trainer/trainings/:trainingRef`

Full detail for one training the trainer is assigned to, **including its sessions and the enrolled participants (roster)**. `:trainingRef` accepts the UUID or the code. Each session includes its **`id` (the `sessionId`)** — use it with `PATCH /api/trainer/sessions/:sessionId/topics` (§3.3.3).

> **Roster privacy:** the `participants` array intentionally exposes **only** `name`, `job_title`, and enrolment `status` (plus stable `participant_id` / `enrolment_id` and `enrolled_at`). Trainers do **not** receive learner contact details (email/phone) or account state — that's admin-only (§3.2.11).

- **Auth:** Bearer access token · role `trainer` · must be currently assigned to this training
- **`200` response:**
  ```json
  {
    "id": "019ef7fe-e436-7c06-89b9-8cb925fd86c0",
    "training_id": "TRN-2026-0001",
    "title": "PMP Certification Training",
    "delivery_mode": "virtual",
    "bucket": "direct_online",
    "status": "active",
    "start_date": "2026-09-15",
    "end_date": "2026-09-18",
    "timezone": "Asia/Kolkata",
    "batch_type": "weekday",
    "venue": null,
    "sessions": [
      {
        "id": "019ef7fe-e438-770a-acf8-a1cce142d198",
        "day_number": 1,
        "planned_topics": "Intro to PMP, framework",
        "start_time": "2026-09-15T03:30:00.000Z",
        "end_time": "2026-09-15T11:30:00.000Z",
        "status": "scheduled"
      }
    ],
    "participants": [
      {
        "enrolment_id": "019ef7fe-e43b-7c06-bfa2-38c688714990",
        "participant_id": "019ef7fe-e43a-7bb5-a70c-4339ab6b83f9",
        "name": "Learner User",
        "job_title": "Project Manager",
        "status": "confirmed",
        "enrolled_at": "2026-06-24T04:58:57.467Z"
      }
    ]
  }
  ```
  `participants` is ordered by name and lists every enrolment for the training (see each row's `status` — e.g. `confirmed`, `cancelled`, `transferred`).
- **Errors:** `401` no/invalid token · `403` not a trainer, or not assigned to this training · `404` training not found

### 3.3.3 `PATCH /api/trainer/sessions/:sessionId/topics`

Lets the **assigned trainer** set/update a session's planned topics. Use the `sessionId` from §3.3.2.

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
  - `buyer` (**required**) — the order's **sponsor**; needs `email` (plus optional `first_name`/`last_name`/`name`/`phone`/`company_name`). Missing/invalid → `422`.
  - `learners[]` (**optional**) — each requires `email` (plus optional name/phone). May be omitted or empty when an order is placed before learners are assigned; the schedule, Training ID, sessions, order record, and sponsor link are still created (with **zero enrolments**), and learners can be added later.
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
- **Accounts:** each learner gets a `users` account (role `learner`); the `buyer` gets one too (role `sponsor`, unless that email already belongs to a learner — then it stays one account that is both) and is linked as the order's sponsor. **Newly created accounts have no password** and are each emailed a setup link (see §2.6) so the user can set one; existing accounts are untouched.
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
      "enrolled_count": 1,
      "sponsor_email": "buyer@example.com"
    }
  }
  ```
- **Errors:** `401` missing/invalid signature · `422` `payment_status` not `paid`, or invalid body

---

## 3.5 Profile (self-service) — `/api/me`

The signed-in user's own profile. **Capability-based:** any authenticated user (any role) can call these — everything is scoped to their own account. Personal + professional fields live on a `user_profiles` record; `email` is **read-only** (login identity), and the display `name` on the account is kept in sync from `first_name + last_name`.

### 3.5.1 `GET /api/me/profile`

- **Auth:** Bearer access token
- **`200` response:**
  ```json
  {
    "user": { "id": "019ef342-...", "name": "Lena Ng", "email": "lena@acme.test", "role": "learner", "is_active": true },
    "profile": {
      "first_name": "Lena", "last_name": "Ng",
      "phone": "+91 90000 00001", "country": "India",
      "time_zone": "Asia/Kolkata", "preferred_language": "en",
      "company_name": "Acme", "job_title": "PM", "department": "Delivery",
      "years_experience": 6, "linkedin_url": "https://linkedin.com/in/lena",
      "avatar_key": "avatars/019ef342-.../e90a....png",
      "avatar_url": "https://<r2>/lms-resources/avatars/...?X-Amz-Signature=..."
    }
  }
  ```
  `avatar_url` is a short-lived (1h) presigned GET URL for the photo (null if none). All profile fields are null until set.
- **Errors:** `401` no/invalid token

### 3.5.2 `PATCH /api/me/profile`

Update any subset of profile fields. **`email` is not accepted** (read-only). Send `null` to clear a field. Editing `first_name`/`last_name` re-syncs the account display `name` (and the linked participant record's name); editing `phone`/`job_title` syncs to the participant record too.

- **Auth:** Bearer access token
- **Body (all optional, ≥1 required):** `first_name, last_name, phone, country, time_zone, preferred_language, company_name, job_title, department, years_experience` (int 0–80), `linkedin_url` (valid URL), `avatar_key`
- **`200` response:** the same shape as §3.5.1 (updated).
- **Errors:** `422` empty/invalid body (e.g. bad `linkedin_url`, out-of-range `years_experience`) · `401` no/invalid token

### 3.5.3 `POST /api/me/profile/avatar-upload-url`

Get a short-lived **presigned PUT URL** so the browser can upload a profile photo directly to object storage (R2). The API never receives the file bytes.

- **Auth:** Bearer access token
- **Body:** `{ "content_type": "image/jpeg" | "image/png" | "image/webp" }`
- **`200` response:**
  ```json
  {
    "upload_url": "https://<r2>/lms-resources/avatars/<user>/<uuid>.png?X-Amz-Signature=...",
    "avatar_key": "avatars/<user>/<uuid>.png",
    "method": "PUT",
    "headers": { "Content-Type": "image/png" },
    "expires_in": 300
  }
  ```
  **Frontend flow:** (1) call this → (2) `PUT` the file bytes to `upload_url` with the `Content-Type` header from `headers` → (3) `PATCH /api/me/profile` with `{ "avatar_key": <the returned key> }`. The next `GET /api/me/profile` returns a viewable `avatar_url`.
- **Errors:** `422` unsupported `content_type` · `503` file storage not configured (R2 env not set) · `401` no/invalid token

---

## 3.6 Sponsor portal — `/api/sponsor`

A **sponsor** is the buyer of ≥1 order (§1.5). These endpoints are **capability-based** — any authenticated user may call them, and everything is scoped to the caller's own sponsored orders (`orders.sponsor_user_id`). A user who has sponsored nothing gets zeros / empty lists.

> **Pricing note:** invoice `amount` / `currency_code`, `outstanding_amount`, and `receipt_url` are **`null`/`0` for now** — the CRM order payload doesn't yet carry pricing and no receipt PDFs are generated. The queries already read from `enrolments.amount`/`currency`, so these light up automatically once pricing is populated. Only `paid` orders are ingested, so nothing is outstanding.

### 3.6.1 `GET /api/sponsor/dashboard`

Summary counts for the sponsor landing page.

- **Auth:** Bearer access token (no role gate)
- **`200` response:**
  ```json
  { "learners_count": 3, "active_count": 3, "invoices_count": 2, "outstanding_amount": 0, "currency_code": null }
  ```
  - `learners_count` — distinct learners sponsored (excludes transferred).
  - `active_count` — distinct sponsored learners with a `confirmed` enrolment in an `active`/`ongoing` training.
  - `invoices_count` — number of the sponsor's orders.
- **Errors:** `401` no/invalid token

### 3.6.2 `GET /api/sponsor/learners`

The learners this sponsor paid for (one row per enrolment; excludes `transferred`).

- **Auth:** Bearer access token (no role gate)
- **`200` response:**
  ```json
  {
    "learners": [
      {
        "id": "019f6071-c142-733d-850c-c92d4da41f8a",
        "name": "Ravi Kumar",
        "email": "ravi.kumar@example.com",
        "training_code": "TRN-2026-0016",
        "training_title": "PMP Certification Training",
        "status": "confirmed",
        "enrolled_at": "2026-07-14T11:44:55.601Z"
      }
    ]
  }
  ```
  `id` is the **enrolment id** (unique per learner-per-training row). Ordered by most recently enrolled.
- **Errors:** `401` no/invalid token

### 3.6.3 `GET /api/sponsor/invoices`

One invoice per order the sponsor placed, newest first.

- **Auth:** Bearer access token (no role gate)
- **`200` response:**
  ```json
  {
    "invoices": [
      {
        "id": "019f6071-c14d-7488-8587-321f4135e994",
        "order_number": "ORD-SPONSOR-SEED-2",
        "course_name": "AWS Solutions Architect",
        "amount": null,
        "currency_code": null,
        "status": "paid",
        "issued_at": "2026-07-14T11:44:55.625Z",
        "receipt_url": null
      }
    ]
  }
  ```
  `status` is the order's `payment_status`. See the pricing note above for `amount`/`currency_code`/`receipt_url`.
- **Errors:** `401` no/invalid token

---

## 3.7 Surveys

Pre/post-training feedback forms. An **admin** authors a survey against a training; **learners** enrolled in that training answer it. Distinct from the certificate-feedback survey (§3.1.x). `questions` is a **flexible array of question objects** — the frontend owns their exact shape (e.g. `{ id, type, label, options?, required? }`); the backend stores them as-is. `answers` is a `{ questionId: answer }` map.

### 3.7.1 `POST /api/admin/trainings/:trainingId/surveys`

Create (assign) a survey for a training. `:trainingId` accepts the UUID or code.

- **Auth:** Bearer access token · role `admin`
- **Body:** `{ "type": "pre_training" | "post_training", "title": "…", "questions": [ { "id": "q1", "type": "rating", "label": "…" }, … ] }` — `questions` must be a non-empty array of objects.
- **`201` response:** `{ "survey": { "id", "training_id", "type", "title", "questions", "assigned_at" } }`
- **Errors:** `422` invalid body · `404` training not found · `403` not an admin

### 3.7.2 `GET /api/admin/trainings/:trainingId/surveys`

List a training's surveys, each with a `response_count`.

- **Auth:** Bearer access token · role `admin`
- **`200` response:** `{ "surveys": [ { "id", "training_id", "type", "title", "questions", "assigned_at", "response_count" } ] }`
- **Errors:** `404` training not found · `403` not an admin

### 3.7.3 `GET /api/admin/surveys/:surveyId/responses`

All responses for a survey (analytics).

- **Auth:** Bearer access token · role `admin`
- **`200` response:**
  ```json
  {
    "survey": { "id": "…", "training_id": "…", "type": "post_training", "title": "Course Feedback", "questions": [ … ], "assigned_at": "…" },
    "responses": [
      { "id": "…", "participant_id": "…", "name": "Lena Ng", "email": "lena@acme.test", "answers": { "q1": 5, "q2": "Great course" }, "submitted_at": "…" }
    ]
  }
  ```
- **Errors:** `404` survey not found · `403` not an admin

### 3.7.4 `GET /api/learner/surveys`

Surveys attached to the caller's enrolled trainings (excludes cancelled/transferred enrolments). **Capability-based** (no role gate).

- **Auth:** Bearer access token
- **`200` response:**
  ```json
  {
    "surveys": [
      {
        "id": "019f653a-…",
        "type": "post_training",
        "title": "Course Feedback",
        "questions": [ { "id": "q1", "type": "rating", "label": "Rate the content" } ],
        "training_code": "TRN-2026-0002",
        "training_title": "PRINCE2 Foundation",
        "assigned_at": "…",
        "answered": false
      }
    ]
  }
  ```
  `answered` is `true` once the caller has submitted this survey — use it to hide/disable already-completed forms.
- **Errors:** `401` no/invalid token

### 3.7.5 `POST /api/learner/surveys/:surveyId/responses`

Submit a survey response. The caller must be an active participant in the survey's training; one response per participant per survey.

- **Auth:** Bearer access token
- **Body:** `{ "answers": { "q1": 5, "q2": "Great course" } }` — non-empty `{ questionId: answer }` map.
- **`201` response:** `{ "id", "survey_id", "submitted_at" }`
- **Errors:** `422` empty/invalid answers · `404` survey not found · `403` not enrolled in the survey's training · `409` already submitted

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

### 4.4 Routing & nav (role + capabilities)

Route to the default portal by `role`; show/hide nav by `capabilities` (§1.5):

```js
// after login / refresh / me you have { user, capabilities }

// 1) default landing portal
const PORTAL_HOME = { admin: "/admin", trainer: "/trainer", sponsor: "/sponsor", learner: "/learner" };
router.push(PORTAL_HOME[user.role] ?? "/learner");

// 2) which sections to render (an account can have several)
const nav = [];
if (capabilities.admin)   nav.push("admin");
if (capabilities.trainer) nav.push("trainer");
if (capabilities.sponsor) nav.push("sponsor");   // Invoices / my learners
if (capabilities.learner) nav.push("learner");   // Course / sessions / surveys
// e.g. a self-buyer lands on /learner but also sees the Sponsor tab.
```

Re-fetch `capabilities` from `GET /api/auth/me` on app load (and after actions that may change access) — they can change after login (§1.5).

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

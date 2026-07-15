# CRM Order Payload — Requested Field Additions

**From:** Invensis LMS team
**To:** xCRM integration team
**Re:** `POST /api/orders` — confirmed-order (`order.paid`) payload
**Date:** 2026-07-15

---

## 1. Context

When a paid order is confirmed, the CRM posts the order payload to our LMS
(`POST /api/orders`, HMAC-signed). We ingest it to create the schedule, Training
ID, sessions, participants, and enrolments.

Several columns already exist in our database schema but stay empty because the
current payload doesn't carry the source data. The fields below are what we need
the CRM to start sending. Everything is **additive** — no existing field changes,
and extra fields are already accepted and stored, so adding these will not break
the current integration.

> **Not requested (we fill these in the LMS ourselves):** `department`,
> `job_title`, `years_experience`. Please do **not** add these.

---

## 2. Requested additions

Legend — **Priority:** P1 = blocking a live feature · P2 = wanted soon · P3 = nice to have.

### 2.1 Learner location  — **P1**

Add a billing/location block **per learner** (inside each `learners[]` entry).
We need this for every order regardless of delivery format — an online learner
still has a billing country. This is our biggest gap.

| Field | Nesting | Type | Required | Maps to LMS |
|---|---|---|---|---|
| `country` | `learners[].billing.country` | string (full name, e.g. `"India"`) | yes | `participants.country` |
| `country_code` | `learners[].billing.country_code` | string (ISO 3166-1 alpha-2, e.g. `"IN"`) | preferred | `participants.country` (we'll normalise) |
| `city` | `learners[].billing.city` | string | optional | `participants.city` |

> If billing already lives under a `customer` object per learner, sending it as
> `learners[].customer.billing.{country, country_code, city}` is equally fine —
> just tell us the exact path.

### 2.2 Per-learner company  — **P2**

The `buyer` already carries `company_name`. We also need the **learner's** own
company (a corporate buyer may enrol staff from different entities).

| Field | Nesting | Type | Required | Maps to LMS |
|---|---|---|---|---|
| `company_name` | `learners[].company_name` | string | optional | `participants.company` |

### 2.3 Pricing / revenue  — **P2**

The `order` block currently sends only `payment_status` and `purchase_type`.
We need the monetary values to power revenue analytics and sponsor invoices
(both are empty today).

| Field | Nesting | Type | Required | Maps to LMS |
|---|---|---|---|---|
| `paid_amount` | `order.paid_amount` | number (total paid for the order) | yes | `enrolments.amount` (we divide by seat count) |
| `currency` | `order.currency` | string (ISO 4217, e.g. `"USD"`, `"INR"`) | yes | `enrolments.currency` |
| `quantity` | `order.quantity` | integer (seats on the order) | preferred | used to derive per-seat `amount` |
| `name` | `package.name` | string (e.g. `"Standard"`, `"Premium"`) | optional | `enrolments.pricing_tier` |

> Note: `order.purchase_type` (`individual` / `corporate` / `one_to_one`) is
> **already sent** and we use it — no change needed there.

### 2.4 Schedule duration detail  — **P3**

`schedule.duration_hours` (total hours) is already sent and works — no change
needed for the total. Optionally, an explicit per-day figure would save us
computing it from `start_time`/`end_time`:

| Field | Nesting | Type | Required | Maps to LMS |
|---|---|---|---|---|
| `hours_per_day` | `schedule.hours_per_day` | number | optional | currently derived from `start_time`/`end_time` |

### 2.5 Capacity (optional)  — **P3**

`capacity` and `min_seats` are **not** sent today; we default them from config.
If the CRM knows the real seat capacity for the offering, sending it would let us
show accurate "seats left".

| Field | Nesting | Type | Required | Maps to LMS |
|---|---|---|---|---|
| `capacity` | `schedule.capacity` | integer | optional | `schedules.capacity` |
| `min_seats` | `schedule.min_seats` | integer | optional | `schedules.min_seats` |

---

## 3. Example payload (additions marked `// NEW`)

```jsonc
{
  "order_id": "INV-20260608-TEST01",
  "customer_id": "CUST-00123",
  "order": {
    "payment_status": "paid",
    "purchase_type": "corporate",
    "paid_amount": 1200.00,       // NEW (2.3)
    "currency": "USD",            // NEW (2.3)
    "quantity": 2                 // NEW (2.3)
  },
  "package": {                    // NEW (2.3)
    "name": "Standard"
  },
  "course": {
    "course_id": 501,
    "course_name": "PMP Certification Training",
    "duration_hours": 32
  },
  "buyer": {
    "customer_id": "CUST-00123",
    "name": "Corp Sponsor",
    "email": "buyer@example.com",
    "phone": "+91 90000 00001",
    "company_name": "Acme Corp"
  },
  "learners": [
    {
      "name": "Ravi Kumar",
      "email": "ravi.kumar@example.com",
      "phone": "+91 90000 10001",
      "company_name": "Acme Corp",   // NEW (2.2)
      "billing": {                    // NEW (2.1)
        "country": "India",
        "country_code": "IN",
        "city": "Bengaluru"
      }
    }
  ],
  "schedule": {
    "schedule_id": "INL000099",
    "event_id": 8821,
    "schedule_variant_id": 4,
    "batch_type": "weekday",
    "delivery_format": "live_virtual",
    "venue": null,
    "timezone": "Asia/Kolkata",
    "start_date": "2026-09-14",
    "end_date": "2026-09-17",
    "start_time": "09:00:00",
    "end_time": "17:00:00",
    "session_dates": ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
    "duration_hours": 32,
    "hours_per_day": 8,             // NEW (2.4, optional)
    "capacity": 20,                 // NEW (2.5, optional)
    "min_seats": 5                  // NEW (2.5, optional)
  }
}
```

---

## 4. Summary checklist

- [ ] **P1** — `learners[].billing.country`, `.country_code`, `.city`
- [ ] **P2** — `learners[].company_name`
- [ ] **P2** — `order.paid_amount`, `order.currency`, `order.quantity`, `package.name`
- [ ] **P3** — `schedule.hours_per_day`
- [ ] **P3** — `schedule.capacity`, `schedule.min_seats`

No breaking changes — all fields are additive and optional at the transport
layer. Please confirm the exact JSON paths you'll use (especially for the learner
billing block) so we can map them precisely.

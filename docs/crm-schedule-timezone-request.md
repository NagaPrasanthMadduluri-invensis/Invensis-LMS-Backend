# CRM Order Payload — Schedule Timezone

**From:** Invensis LMS team
**To:** xCRM integration team
**Re:** `POST /api/orders` — the `schedule` block
**Date:** 2026-09-15

> Companion to `crm-payload-additions-request.md`. That document covers learner
> billing, pricing and capacity. This one is **only** about the schedule's
> timezone. Everything here is additive and optional at the transport layer — no
> existing field changes and nothing breaks if you ship it gradually.

---

## 1. The problem

The trainer portal shows each trainer their session times **in their own
timezone** ("this Manila session starts 6:30 AM your time"). To do that we need
to know which timezone the session times are expressed in.

Today `schedule.timezone` can arrive as a bare abbreviation such as `"PHT"` or
`"CST"`. Abbreviations are not unique, so they are not enough:

| Abbreviation | Could mean | Offset |
|---|---|---|
| `CST` | China Standard Time | UTC+8 |
| `CST` | Taiwan | UTC+8 |
| `CST` | Mexico / US Central | **UTC−6** |
| `IST` | India Standard Time | UTC+5:30 |
| `IST` | Israel Standard Time | **UTC+2** |

`CST` is the dangerous one: China and Mexico are **14 hours apart**. A trainer
told the wrong one joins the call half a day late, and nothing on screen
suggests the time is wrong.

---

## 2. What we need — two options, either one solves it

### Option A — send an IANA zone name  ✅ *preferred*

Send `schedule.timezone` as an [IANA tz database](https://www.iana.org/time-zones)
name instead of an abbreviation:

```diff
- "timezone": "PHT"
+ "timezone": "Asia/Manila"
```

**Nothing else is needed.** An IANA name is unique by definition, is DST-aware,
and is understood natively by every browser and backend language. This removes
the entire class of problem permanently, including for countries nobody has
thought of yet.

### Option B — keep the abbreviation, add the country

If the abbreviation is hard to change, send the country alongside it and we will
resolve the pair ourselves:

```diff
  "timezone": "PHT",
+ "country_code": "PH"
```

This works, but it needs a lookup table on our side and has to be extended each
time you sell into a new country. **Please prefer Option A** and treat B as the
fallback.

You may also send both — we use the IANA name when present.

---

## 3. The `schedule` block — before and after

### 3.1 BEFORE (exactly what we accept today)

```jsonc
{
  "schedule": {
    "schedule_id": "INL000099",
    "event_id": 8821,
    "schedule_variant_id": 4,
    "batch_type": "weekday",
    "delivery_format": "live_virtual",
    "venue": null,

    "timezone": "PHT",                 // ← ambiguous / unresolvable

    "start_date": "2026-09-14",
    "end_date": "2026-09-17",
    "start_time": "09:00:00",
    "end_time": "17:00:00",
    "session_dates": ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
    "duration_hours": 32,
    "hours_per_day": 8
  }
}
```

### 3.2 AFTER — Option A (preferred)

```jsonc
{
  "schedule": {
    "schedule_id": "INL000099",
    "event_id": 8821,
    "schedule_variant_id": 4,
    "batch_type": "weekday",
    "delivery_format": "live_virtual",
    "venue": null,

    "timezone": "Asia/Manila",         // CHANGED — IANA zone name, not "PHT"

    "start_date": "2026-09-14",
    "end_date": "2026-09-17",
    "start_time": "09:00:00",
    "end_time": "17:00:00",
    "session_dates": ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
    "duration_hours": 32,
    "hours_per_day": 8
  }
}
```

### 3.3 AFTER — Option B (fallback)

```jsonc
{
  "schedule": {
    "schedule_id": "INL000099",
    "event_id": 8821,
    "schedule_variant_id": 4,
    "batch_type": "weekday",
    "delivery_format": "live_virtual",
    "venue": null,

    "timezone": "PHT",                 // unchanged
    "country_code": "PH",              // NEW — ISO 3166-1 alpha-2

    "start_date": "2026-09-14",
    "end_date": "2026-09-17",
    "start_time": "09:00:00",
    "end_time": "17:00:00",
    "session_dates": ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
    "duration_hours": 32,
    "hours_per_day": 8
  }
}
```

---

## 4. Field specification

| Field | Path | Type | Required | Notes |
|---|---|---|---|---|
| `timezone` | `schedule.timezone` | string | preferred | **Option A.** IANA zone name, e.g. `"Asia/Manila"`. Must contain a `/`. Takes precedence over everything else. |
| `country_code` | `schedule.country_code` | string | fallback | **Option B.** ISO 3166-1 alpha-2, uppercase, e.g. `"PH"`. Used only when `timezone` is not an IANA name. |
| `timezone_code` | `schedule.timezone_code` | string | optional | Already accepted; used only as a fallback for `timezone`. Keep sending if you already do. |

### Accepted shapes for the country

All three are accepted, so send whichever matches your existing model — no
restructuring needed:

```jsonc
"country_code": "PH"                        // preferred
"country": { "iso_code_2": "PH" }           // CMS schedule-listing shape
"country": "PH"                             // bare string
```

We uppercase and validate it against `^[A-Z]{2}$`; anything else is ignored
rather than rejected, so a malformed value can never fail an order.

---

## 5. Countries currently affected

Observed from the live CMS `schedule-listing` endpoint. We have already added
local handling for the unambiguous codes, so **the remaining ask is small**:

### Still broken without a change from CRM

| Code | Countries | Symptom today |
|---|---|---|
| `CST` | China, Taiwan, Mexico | **No conversion shown at all** — we refuse rather than risk a 14-hour error |
| `IST` | Israel (vs India) | **Silently 3.5 hours wrong** — we assume India, which is right for `IN`, wrong for `IL` |

### Already handled on our side (no CRM change strictly required)

`PHT` `MYT` `HKT` `KST` `ICT` `WIB` `SAST` `BRT` `NZDT` `ACDT` `EET` `WET` `EAT`
`GST` `SGT` `JST` `GMT` `CET` `EST` `AST`

We would still prefer Option A for these, so the mapping table can eventually be
deleted rather than maintained forever.

---

## 6. Compatibility

- **Additive.** No existing field changes meaning or type.
- **Optional.** Orders without these fields keep working exactly as now.
- **Safe to roll out per-country.** No coordinated release needed.
- Unknown extra fields are already accepted and stored on `orders.payload` for
  traceability, so sending them early is harmless.

---

## 7. Questions for the CRM team

1. **What does `schedule.timezone` currently contain, per country?** An IANA
   name (`"Asia/Kolkata"`), an abbreviation (`"PHT"`), or does it vary? This is
   the one thing we cannot determine from our side.
2. Do you also send `schedule.timezone_code`, and if so how does it differ from
   `schedule.timezone`?
3. Can you move to IANA names (Option A)? If yes, roughly when — we will keep the
   abbreviation fallback until you confirm it is no longer needed.
4. If Option B, confirm the exact JSON path you will use for the country.

---

## 8. How to verify a change

`POST /api/orders` is HMAC-signed (see `API.md` §3.4). Sign the exact bytes:

```js
import crypto from "node:crypto";
const body = JSON.stringify(order);
const sig = "sha256=" + crypto
  .createHmac("sha256", process.env.ORDER_HMAC_SECRET)
  .update(body)
  .digest("hex");
// POST with headers: { "Content-Type": "application/json", "X-Signature": sig }
```

After ingest, confirm the value landed:

```sql
SELECT external_schedule_code, timezone, country_code
FROM schedules
WHERE external_schedule_code = 'INL000099';
```

Expected — Option A: `timezone = 'Asia/Manila'`.
Expected — Option B: `timezone = 'PHT'`, `country_code = 'PH'`.

Then open the training in the trainer portal: the "Check your timezone to join
the meeting" panel should convert the session times rather than showing a
warning.

---

## 9. Summary checklist

- [ ] Confirm what `schedule.timezone` contains today, per country (§7.1)
- [ ] **Preferred** — send `schedule.timezone` as an IANA zone name
- [ ] **Or** — send `schedule.country_code` (ISO 3166-1 alpha-2) alongside the abbreviation
- [ ] Priority countries: **CN, TW, MX** (`CST`) and **IL** (`IST`)

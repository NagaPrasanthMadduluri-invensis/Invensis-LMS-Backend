import { sql } from "drizzle-orm";
import { db } from "../../config/db.js";

/*
 * Reports service — a SALES/REVENUE-first snapshot of the business, distinct
 * from the analytics dashboard (which is chart-first and operational). Reports
 * answers "where are sales happening, and where are they weak?" over a
 * customizable time range, and feeds the PDF exports.
 *
 * SQL follows the same fragment-builder approach as admin.getAnalytics: reusable
 * WHERE fragments parameterised by table alias, enum columns cast to text so
 * bound string params compare cleanly. Revenue only ever counts money that
 * actually landed — enrolments in ('confirmed','completed').
 */

// Categorical training filter, parameterised by the training-row alias.
function trainingConds(f, alias) {
  const a = sql.raw(alias);
  const c = [sql`true`];
  if (f.status) c.push(sql`${a}.status::text = ${f.status}`);
  if (f.delivery_mode) c.push(sql`${a}.delivery_mode::text = ${f.delivery_mode}`);
  if (f.bucket) c.push(sql`${a}.bucket::text = ${f.bucket}`);
  if (f.trainer_id)
    c.push(sql`exists (
      select 1 from trainer_assignments ta
      where ta.training_id = ${a}.id
        and ta.trainer_id = ${f.trainer_id}
        and ta.removed_at is null)`);
  if (f.duration)
    c.push(sql`exists (
      select 1 from schedules s
      where s.id = ${a}.schedule_id
        and round(extract(epoch from (s.end_time - s.start_time)) / 3600)::int = ${f.duration})`);
  return sql.join(c, sql` and `);
}

// Date-range fragment against a column expression (cast: 'date' | 'timestamptz').
function dateConds(f, colExpr, cast) {
  const c = [sql`true`];
  if (f.from) c.push(sql`${colExpr} >= ${f.from}::${sql.raw(cast)}`);
  if (f.to) c.push(sql`${colExpr} <= ${f.to}::${sql.raw(cast)}`);
  return sql.join(c, sql` and `);
}

// Learner-attribute filters (enrolment grain) — participant alias p, enrolment e.
function enrolConds(f) {
  const c = [sql`true`];
  if (f.location) c.push(sql`p.country = ${f.location}`);
  if (f.sponsorship) c.push(sql`e.sponsorship = ${f.sponsorship}`);
  return sql.join(c, sql` and `);
}

// Money that actually landed.
const paidRevenue = sql`coalesce(sum(e.amount) filter (where e.status in ('confirmed', 'completed')), 0)::float`;
const round0 = (n) => Math.round(n ?? 0);

export async function getSalesReport(filters = {}) {
  const f = filters;
  const tc = (alias) => trainingConds(f, alias);
  const ec = enrolConds(f);
  const dc = dateConds(f, sql`e.enrolled_at`, "timestamptz");

  // Common FROM/WHERE for enrolment-grain revenue queries.
  const revFrom = sql`
    from enrolments e
    join training_ids ti on ti.id = e.training_id
    join participants p on p.id = e.participant_id
    where ${tc("ti")} and ${ec} and ${dc}`;

  // ── Growth & momentum: derive the "previous equal period" ──
  // Current window = [from, to] (to defaults to today). The previous window is
  // the same-length span immediately before it. No `from` (all time) → no
  // comparison. Prev uses a half-open upper bound so it can't overlap current.
  const today = new Date().toISOString().slice(0, 10);
  let prevWindow = null;
  if (f.from) {
    const fromMs = Date.parse(`${f.from}T00:00:00Z`);
    const toMs = Date.parse(`${f.to ?? today}T00:00:00Z`);
    const span = toMs - fromMs;
    if (span > 0) {
      prevWindow = {
        from: new Date(fromMs - span).toISOString().slice(0, 10),
        to: f.from,
      };
    }
  }
  const prevRevFrom = prevWindow
    ? sql`
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${tc("ti")} and ${ec}
        and e.enrolled_at >= ${prevWindow.from}::timestamptz
        and e.enrolled_at < ${prevWindow.to}::timestamptz`
    : null;

  // Restrict trainer metrics to the trainer named in the filter (if any). The
  // rest of the trainer scoping is driven by the filtered enrolment/training set
  // (below), so date range + every categorical/learner filter flows through.
  const trainerIdCond = f.trainer_id ? sql`ta.trainer_id = ${f.trainer_id}` : sql`true`;

  const [
    summaryRes,
    overTimeRes,
    byLocationRes,
    byCourseRes,
    byTierRes,
    bySponsorshipRes,
    byBucketRes,
    byModeRes,
    currencyRes,
    trainerOptionsRes,
    locationOptionsRes,
    durationOptionsRes,
    prevSummaryRes,
    topCompaniesRes,
    companiesCountRes,
    retentionRes,
    trainerSummaryRes,
    topTrainersRes,
  ] = await Promise.all([
    // KPI summary.
    db.execute(sql`
      select
        ${paidRevenue} as revenue,
        count(*)::int as enrolments_total,
        count(*) filter (where e.status in ('confirmed','completed'))::int as paying_enrolments,
        count(distinct e.participant_id)::int as participants,
        count(distinct e.order_id)::int as orders
      ${revFrom}
    `),

    // Monthly revenue + paying enrolments (time series for the report + trend).
    db.execute(sql`
      select to_char(date_trunc('month', e.enrolled_at), 'YYYY-MM') as month,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom}
      group by 1 order by 1
    `),

    // Sales by learner billing location — the headline "where sales happen".
    db.execute(sql`
      select coalesce(p.country, 'Unknown') as location,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom}
      group by 1 order by revenue desc, enrolments desc
    `),

    // Sales by course.
    db.execute(sql`
      select ti.title,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom}
      group by ti.title order by revenue desc, enrolments desc
    `),

    // Sales by pricing tier (xCRM package).
    db.execute(sql`
      select coalesce(e.pricing_tier, 'Unspecified') as tier,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom}
      group by 1 order by revenue desc
    `),

    // Sales by sponsorship (self vs corporate).
    db.execute(sql`
      select coalesce(e.sponsorship, 'unspecified') as sponsorship,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom}
      group by 1 order by revenue desc
    `),

    // Sales by bucket.
    db.execute(sql`
      select ti.bucket::text as bucket,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom}
      group by 1 order by revenue desc
    `),

    // Sales by delivery mode.
    db.execute(sql`
      select ti.delivery_mode::text as delivery_mode,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom}
      group by 1 order by revenue desc
    `),

    // Dominant currency in the filtered set (falls back to USD when no revenue).
    db.execute(sql`
      select coalesce(e.currency, 'USD') as currency, count(*)::int as n
      ${revFrom} and e.amount is not null
      group by 1 order by n desc limit 1
    `),

    // Filter dropdown options (filter-independent).
    db.execute(sql`
      select tr.id, u.name from trainers tr
      join users u on u.id = tr.user_id
      where tr.is_active = true order by u.name
    `),
    db.execute(sql`select distinct country as location from participants where country is not null order by 1`),
    db.execute(sql`
      select distinct round(extract(epoch from (end_time - start_time)) / 3600)::int as hours
      from schedules order by 1
    `),

    // ── Growth & momentum: previous-period revenue + paying enrolments ──
    prevRevFrom
      ? db.execute(sql`
          select ${paidRevenue} as revenue,
            count(*) filter (where e.status in ('confirmed','completed'))::int as paying_enrolments
          ${prevRevFrom}
        `)
      : Promise.resolve({ rows: [{}] }),

    // ── Customers: top corporate accounts (named companies only) ──
    db.execute(sql`
      select p.company,
        ${paidRevenue} as revenue,
        count(*) filter (where e.status in ('confirmed','completed'))::int as enrolments
      ${revFrom} and p.company is not null
      group by p.company order by revenue desc, enrolments desc limit 8
    `),
    db.execute(sql`
      select count(distinct p.company)::int as n
      ${revFrom} and p.company is not null
    `),

    // ── Customers: new vs returning learners (within the period) ──
    db.execute(sql`
      select case when cnt > 1 then 'returning' else 'new' end as kind, count(*)::int as learners
      from (
        select e.participant_id, count(*)::int as cnt
        from enrolments e
        join training_ids ti on ti.id = e.training_id
        join participants p on p.id = e.participant_id
        where ${tc("ti")} and ${ec} and ${dc} and e.status in ('confirmed','completed')
        group by e.participant_id
      ) x group by 1
    `),

    // ── Trainers: engaged trainers + trainings WITHIN the filtered scope ──
    // A trainer is "engaged" if they currently deliver a training that has ≥1
    // enrolment matching the full filter set (date + categorical + learner). So
    // this reacts to every global filter, not just the trainer dropdown.
    db.execute(sql`
      select
        count(distinct ta.trainer_id)::int as engaged,
        count(distinct ta.training_id)::int as trainings
      from trainer_assignments ta
      where ta.removed_at is null and ${trainerIdCond}
        and exists (
          select 1 from enrolments e
          join training_ids ti on ti.id = e.training_id
          join participants p on p.id = e.participant_id
          where e.training_id = ta.training_id and ${tc("ti")} and ${ec} and ${dc})
    `),
    // ── Trainers: top by load within the filtered scope ──
    // participants = filtered enrolments in the trainings each trainer delivers.
    db.execute(sql`
      select u.name,
        count(distinct ta.training_id)::int as trainings,
        count(fe.id)::int as participants
      from trainer_assignments ta
      join trainers tr on tr.id = ta.trainer_id
      join users u on u.id = tr.user_id
      join (
        select e.id, e.training_id
        from enrolments e
        join training_ids ti on ti.id = e.training_id
        join participants p on p.id = e.participant_id
        where ${tc("ti")} and ${ec} and ${dc}
      ) fe on fe.training_id = ta.training_id
      where ta.removed_at is null and ${trainerIdCond}
      group by u.name
      order by trainings desc, participants desc limit 8
    `),
  ]);

  const s = summaryRes.rows[0] ?? {};
  const revenue = round0(s.revenue);
  const paying = s.paying_enrolments ?? 0;
  const currency = currencyRes.rows[0]?.currency ?? "USD";

  const byLocation = byLocationRes.rows.map((r) => ({
    location: r.location,
    revenue: round0(r.revenue),
    enrolments: r.enrolments,
  }));
  const byCourse = byCourseRes.rows.map((r) => ({
    title: r.title,
    revenue: round0(r.revenue),
    enrolments: r.enrolments,
  }));

  // "Where sales are weak" — bottom performers among locations that made ≥1 sale.
  const locationsWithSales = byLocation.filter((r) => r.revenue > 0);
  const lowLocations = [...locationsWithSales].sort((a, b) => a.revenue - b.revenue).slice(0, 5);

  // ── Growth & momentum vs the previous equal period ──
  const prev = prevSummaryRes.rows[0] ?? {};
  const prevRevenue = round0(prev.revenue);
  const prevPaying = prev.paying_enrolments ?? 0;
  const prevAvg = prevPaying > 0 ? prevRevenue / prevPaying : 0;
  const curAvg = paying > 0 ? revenue / paying : 0;
  const pct = (cur, base) => (base > 0 ? Math.round(((cur - base) / base) * 1000) / 10 : null);
  const comparison = prevWindow
    ? {
        previous_period: prevWindow,
        previous: {
          revenue_total: prevRevenue,
          paying_enrolments: prevPaying,
          avg_per_enrolment: Math.round(prevAvg * 100) / 100,
        },
        delta: {
          revenue_pct: pct(revenue, prevRevenue),
          enrolments_pct: pct(paying, prevPaying),
          avg_pct: pct(curAvg, prevAvg),
        },
      }
    : null;

  // ── Customers: top accounts + concentration (top-5 share of revenue) ──
  const topCompanies = topCompaniesRes.rows.map((r) => ({
    company: r.company,
    revenue: round0(r.revenue),
    enrolments: r.enrolments,
  }));
  const top5Revenue = topCompanies.slice(0, 5).reduce((s, c) => s + c.revenue, 0);
  const concentration = {
    companies_total: companiesCountRes.rows[0]?.n ?? 0,
    top5_revenue: top5Revenue,
    top5_pct: revenue > 0 ? Math.round((top5Revenue / revenue) * 1000) / 10 : null,
  };

  // ── Customers: new vs returning learners within the period ──
  const retMap = Object.fromEntries(retentionRes.rows.map((r) => [r.kind, r.learners]));
  const newLearners = retMap.new ?? 0;
  const returningLearners = retMap.returning ?? 0;
  const learnersActive = newLearners + returningLearners;
  const retention = {
    new_learners: newLearners,
    returning_learners: returningLearners,
    repeat_rate: learnersActive > 0 ? Math.round((returningLearners / learnersActive) * 1000) / 10 : 0,
  };

  // ── Trainers: engaged trainers within the filtered scope + revenue-per-trainer ──
  const trSum = trainerSummaryRes.rows[0] ?? {};
  const engaged = trSum.engaged ?? 0;
  const trainers = {
    engaged,
    trainings: trSum.trainings ?? 0,
    revenue_per_trainer: engaged > 0 ? Math.round(revenue / engaged) : 0,
  };
  const topTrainers = topTrainersRes.rows
    .filter((r) => r.name)
    .map((r) => ({ name: r.name, trainings: r.trainings, participants: r.participants }));

  return {
    generated_at: new Date().toISOString(),
    filters: {
      from: f.from ?? null,
      to: f.to ?? null,
      delivery_mode: f.delivery_mode ?? null,
      bucket: f.bucket ?? null,
      status: f.status ?? null,
      trainer_id: f.trainer_id ?? null,
      location: f.location ?? null,
      duration: f.duration ?? null,
      sponsorship: f.sponsorship ?? null,
    },
    currency,
    summary: {
      revenue_total: revenue,
      enrolments_total: s.enrolments_total ?? 0,
      paying_enrolments: paying,
      participants: s.participants ?? 0,
      orders: s.orders ?? 0,
      avg_per_enrolment: paying > 0 ? Math.round((revenue / paying) * 100) / 100 : 0,
    },
    sales_over_time: overTimeRes.rows.map((r) => ({
      month: r.month,
      revenue: round0(r.revenue),
      enrolments: r.enrolments,
    })),
    sales_by_location: byLocation,
    low_performing_locations: lowLocations,
    sales_by_course: byCourse,
    sales_by_tier: byTierRes.rows.map((r) => ({
      tier: r.tier,
      revenue: round0(r.revenue),
      enrolments: r.enrolments,
    })),
    sales_by_sponsorship: bySponsorshipRes.rows.map((r) => ({
      sponsorship: r.sponsorship,
      revenue: round0(r.revenue),
      enrolments: r.enrolments,
    })),
    sales_by_bucket: byBucketRes.rows.map((r) => ({
      bucket: r.bucket,
      revenue: round0(r.revenue),
      enrolments: r.enrolments,
    })),
    sales_by_delivery_mode: byModeRes.rows.map((r) => ({
      delivery_mode: r.delivery_mode,
      revenue: round0(r.revenue),
      enrolments: r.enrolments,
    })),
    // Growth & momentum
    comparison,
    // Customers & trainers
    concentration,
    top_companies: topCompanies,
    learner_retention: retention,
    trainers,
    top_trainers: topTrainers,
    trainer_options: trainerOptionsRes.rows.map((r) => ({ id: r.id, name: r.name })),
    location_options: locationOptionsRes.rows.map((r) => r.location),
    duration_options: durationOptionsRes.rows.map((r) => r.hours),
  };
}

export async function getSalesRecords(filters = {}) {
  const f = filters;
  const tc = (alias) => trainingConds(f, alias);
  const ec = enrolConds(f);
  const dc = dateConds(f, sql`e.enrolled_at`, "timestamptz");
  const page = f.page ?? 1;
  const limit = f.limit ?? 1000;
  const offset = (page - 1) * limit;

  const where = sql`${tc("ti")} and ${ec} and ${dc}`;

  const [rowsRes, countRes] = await Promise.all([
    db.execute(sql`
      select
        e.enrolled_at,
        o.external_order_id as order_id,
        ti.code as training_code,
        ti.title as course,
        ti.delivery_mode::text as delivery_mode,
        ti.bucket::text as bucket,
        p.name as participant,
        p.email,
        coalesce(p.country, 'Unknown') as country,
        p.city,
        e.status::text as status,
        e.sponsorship,
        e.pricing_tier,
        e.amount::float as amount,
        e.currency
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      left join orders o on o.id = e.order_id
      where ${where}
      order by e.enrolled_at desc
      limit ${limit} offset ${offset}
    `),
    db.execute(sql`
      select count(*)::int as total
      from enrolments e
      join training_ids ti on ti.id = e.training_id
      join participants p on p.id = e.participant_id
      where ${where}
    `),
  ]);

  const total = countRes.rows[0]?.total ?? 0;
  return {
    generated_at: new Date().toISOString(),
    page,
    limit,
    total,
    returned: rowsRes.rows.length,
    truncated: total > offset + rowsRes.rows.length,
    records: rowsRes.rows.map((r) => ({
      enrolled_at: r.enrolled_at,
      order_id: r.order_id,
      training_code: r.training_code,
      course: r.course,
      delivery_mode: r.delivery_mode,
      bucket: r.bucket,
      participant: r.participant,
      email: r.email,
      country: r.country,
      city: r.city,
      status: r.status,
      sponsorship: r.sponsorship,
      pricing_tier: r.pricing_tier,
      amount: r.amount == null ? null : Math.round(r.amount * 100) / 100,
      currency: r.currency,
    })),
  };
}

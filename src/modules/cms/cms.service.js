/**
 * CMS integration — fetches the course catalogue and per-course schedule
 * listings from the external Invensis CMS and normalizes them into stable,
 * snake_case shapes the LMS can rely on regardless of upstream additions.
 */
import { env } from "../../config/env.js";
import { cmsGet } from "../../lib/cms-client.js";

// CMS booleans arrive as strings ("true"/"false") or real booleans; absent → false.
function cmsBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.trim().toLowerCase());
  return false;
}

// Whether the certification is included, read from CMS `meta.certification_inculded`
// (note the upstream misspelling; we also accept the corrected spelling). Absent → false.
function certificationIncluded(c = {}) {
  const meta = c.meta ?? {};
  return cmsBool(meta.certification_inculded ?? meta.certification_included);
}

function normalizeCourse(c = {}) {
  return {
    certification_included: certificationIncluded(c),
    id: c.id ?? null,
    name: c.name ?? null,
    slug: c.slug ?? null,
    short_name: c.short_name ?? null,
    description: c.description ?? null,
    course_type: c.course_type ?? null,
    duration_hours: c.duration_hours ?? null,
    has_exam: c.has_exam ?? false,
    is_professional_certificate: c.is_professional_certificate ?? false,
    icon_url: c.icon_url ?? null,
    banner_image_url: c.banner_image_url ?? null,
    brochure_url: c.brochure_url ?? null,
    video_thumbnail_url: c.video_thumbnail_url ?? null,
    category: c.category
      ? { name: c.category.name ?? null, slug: c.category.slug ?? null }
      : null,
    course_group: c.course_group
      ? {
          name: c.course_group.name ?? null,
          slug: c.course_group.slug ?? null,
          available_tiers: c.course_group.available_tiers ?? null,
        }
      : null,
    meta: {
      total_reviews: c.meta?.total_reviews ?? 0,
      average_rating: c.meta?.average_rating ?? 0,
      total_learners: c.meta?.total_learners ?? 0,
    },
    accreditations: Array.isArray(c.accreditations) ? c.accreditations : [],
    addons: Array.isArray(c.addons) ? c.addons : [],
  };
}

function normalizeSchedule(s = {}) {
  return {
    id: s.id ?? null,
    variant_id: s.variant_id ?? null,
    event_id: s.event_id ?? null,
    event_code: s.event_code ?? null,
    course: s.course
      ? { id: s.course.id ?? null, name: s.course.name ?? null, slug: s.course.slug ?? null }
      : null,
    training_mode: s.training_mode ?? null,
    duration_hours: s.duration_hours ?? null,
    hours_per_day: s.hours_per_day ?? null,
    batch_type: s.batch_type ?? null,
    start_date: s.start_date ?? null,
    end_date: s.end_date ?? null,
    session_dates: Array.isArray(s.session_dates) ? s.session_dates : [],
    start_time: s.start_time ?? null,
    end_time: s.end_time ?? null,
    timezone_code: s.timezone_code ?? null,
    time_slot_label: s.time_slot_label ?? null,
    country: s.country
      ? { name: s.country.name ?? null, iso_code_2: s.country.iso_code_2 ?? null }
      : null,
    pricing_tier: s.pricing_tier
      ? { name: s.pricing_tier.name ?? null, slug: s.pricing_tier.slug ?? null }
      : null,
    final_price: s.final_price ?? null,
    currency_code: s.currency_code ?? null,
    venue: s.venue ?? null,
    capacity: s.capacity ?? null,
    enrolled_count: s.enrolled_count ?? 0,
    auto_coupon: s.auto_coupon ?? null,
  };
}

/**
 * List the CMS course catalogue.
 * @param {object} [filters]  optional passthrough filters (category, search, page, per_page, country)
 * @returns {Promise<{ courses: object[], meta: object|null }>}
 */
export async function listCourses(filters = {}) {
  const body = await cmsGet("/courses", filters);
  const data = Array.isArray(body?.data) ? body.data : [];
  return {
    courses: data.map(normalizeCourse),
    // Upstream pagination/meta, passed through untouched when present.
    meta: body?.meta ?? null,
  };
}

/**
 * Fetch one course by its CMS slug (detail endpoint — richer `meta`).
 * @param {string} courseSlug
 * @returns {Promise<{ course: object|null }>}
 */
export async function getCourseBySlug(courseSlug) {
  const body = await cmsGet(`/courses/${encodeURIComponent(courseSlug)}`);
  const raw = body?.data ?? body ?? null;
  return { course: raw ? normalizeCourse(raw) : null };
}

/**
 * Best-effort course facts for the order-confirm flow: never throws, never
 * blocks enrolment. Returns `certification_included: false` and null type when
 * the CMS can't be reached — a later re-confirm/backfill can correct it.
 * @param {string} [courseSlug]
 * @returns {Promise<{ course_slug: string|null, course_type: string|null, certification_included: boolean }>}
 */
export async function resolveCourseFacts(courseSlug) {
  const base = { course_slug: courseSlug ?? null, course_type: null, certification_included: false };
  if (!courseSlug) return base;
  try {
    const { course } = await getCourseBySlug(courseSlug);
    if (!course) return base;
    return {
      course_slug: courseSlug,
      course_type: course.course_type ?? null,
      certification_included: !!course.certification_included,
    };
  } catch {
    return base; // CMS down/slow/404 — don't fail the order
  }
}

/**
 * List the upcoming schedules for one course (by CMS slug), for a country.
 * @param {string} courseSlug
 * @param {object} [opts]
 * @param {string} [opts.country]  ISO country (defaults to CMS_DEFAULT_COUNTRY)
 * @returns {Promise<{ course_slug: string, country: string, schedules: object[], meta: object|null }>}
 */
export async function listSchedules(courseSlug, { country } = {}) {
  const resolvedCountry = country || env.CMS_DEFAULT_COUNTRY;
  const body = await cmsGet(
    `/courses/${encodeURIComponent(courseSlug)}/schedule-listing`,
    { country: resolvedCountry }
  );
  const data = Array.isArray(body?.data) ? body.data : [];
  return {
    course_slug: courseSlug,
    country: resolvedCountry,
    schedules: data.map(normalizeSchedule),
    meta: body?.meta ?? null,
  };
}

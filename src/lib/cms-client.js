/**
 * Client for the external Invensis CMS (courses + schedule listings).
 *
 * Read-only, unauthenticated upstream by default; set CMS_API_KEY to send a
 * Bearer token. All requests are time-boxed (CMS_API_TIMEOUT_MS) so a slow or
 * down CMS can't hang an LMS request — a failure surfaces as a 502 AppError.
 */
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

// Build "<base>/<path>?<query>" from a leading-slash path and a params object.
// Skips null/undefined/"" params so callers can pass optional filters freely.
function buildUrl(path, query = {}) {
  const base = env.CMS_API_BASE_URL.replace(/\/+$/, "");
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * GET a CMS endpoint and return the parsed JSON body.
 * @param {string} path  e.g. "/courses" or "/courses/<slug>/schedule-listing"
 * @param {object} [query]  query params (falsy values skipped)
 * @throws {AppError} 502 on network/timeout/non-2xx/non-JSON upstream responses
 */
export async function cmsGet(path, query = {}) {
  const url = buildUrl(path, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.CMS_API_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(env.CMS_API_KEY ? { Authorization: `Bearer ${env.CMS_API_KEY}` } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    throw new AppError(timedOut ? "CMS request timed out" : "Could not reach the CMS", 502);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) throw new AppError("Not found in CMS", 404);
  if (!res.ok) throw new AppError(`CMS responded with ${res.status}`, 502);

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new AppError("CMS returned an unexpected (non-JSON) response", 502);
  }
  return res.json();
}

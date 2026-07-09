import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../config/db.js";
import { users, userProfiles, participants } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { storageConfigured, presignPut, presignGet } from "../../lib/storage.js";

// snake_case request key → user_profiles column
const COLUMN = {
  first_name: "firstName",
  last_name: "lastName",
  phone: "phone",
  country: "country",
  time_zone: "timeZone",
  preferred_language: "preferredLanguage",
  company_name: "companyName",
  job_title: "jobTitle",
  department: "department",
  years_experience: "yearsExperience",
  linkedin_url: "linkedinUrl",
  avatar_key: "avatarKey",
};

function publicProfile(p) {
  return {
    first_name: p?.firstName ?? null,
    last_name: p?.lastName ?? null,
    phone: p?.phone ?? null,
    country: p?.country ?? null,
    time_zone: p?.timeZone ?? null,
    preferred_language: p?.preferredLanguage ?? null,
    company_name: p?.companyName ?? null,
    job_title: p?.jobTitle ?? null,
    department: p?.department ?? null,
    years_experience: p?.yearsExperience ?? null,
    linkedin_url: p?.linkedinUrl ?? null,
    avatar_key: p?.avatarKey ?? null,
  };
}

async function loadProfileRow(runner, userId) {
  const [row] = await runner
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getProfile(userId) {
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new AppError("User not found", 404);

  const profile = await loadProfileRow(db, userId);
  const avatarKey = profile?.avatarKey ?? null;
  const avatarUrl = avatarKey ? await presignGet(avatarKey) : null;

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, is_active: user.isActive },
    profile: { ...publicProfile(profile), avatar_url: avatarUrl },
  };
}

export async function updateProfile(userId, body) {
  await db.transaction(async (tx) => {
    const existing = await loadProfileRow(tx, userId);

    // Map provided keys to columns.
    const set = { updatedAt: new Date() };
    for (const [key, col] of Object.entries(COLUMN)) {
      if (key in body) set[col] = body[key];
    }

    if (existing) {
      await tx.update(userProfiles).set(set).where(eq(userProfiles.userId, userId));
    } else {
      await tx.insert(userProfiles).values({ userId, ...set });
    }

    // Keep users.name (display name) + participant row in sync.
    const firstName = "first_name" in body ? body.first_name : existing?.firstName;
    const lastName = "last_name" in body ? body.last_name : existing?.lastName;
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();

    const userSet = { updatedAt: new Date() };
    if (("first_name" in body || "last_name" in body) && displayName) userSet.name = displayName;
    if (Object.keys(userSet).length > 1) {
      await tx.update(users).set(userSet).where(eq(users.id, userId));
    }

    // Sync self-edited phone/job_title/name to the participant record if any.
    const partSet = { updatedAt: new Date() };
    if ("phone" in body) partSet.phone = body.phone;
    if ("job_title" in body) partSet.jobTitle = body.job_title;
    if (userSet.name) partSet.name = userSet.name;
    if (Object.keys(partSet).length > 1) {
      await tx.update(participants).set(partSet).where(eq(participants.userId, userId));
    }
  });

  return getProfile(userId);
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function createAvatarUploadUrl(userId, contentType) {
  if (!storageConfigured()) {
    throw new AppError("File storage is not configured", 503);
  }
  const key = `avatars/${userId}/${randomUUID()}.${EXT[contentType]}`;
  const uploadUrl = await presignPut(key, contentType);
  return {
    upload_url: uploadUrl,
    avatar_key: key,
    method: "PUT",
    headers: { "Content-Type": contentType },
    expires_in: 300,
    // After a successful PUT, PATCH /api/me/profile with { "avatar_key": <this> }.
  };
}

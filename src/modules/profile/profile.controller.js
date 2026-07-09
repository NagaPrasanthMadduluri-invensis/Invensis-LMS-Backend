import { updateProfileSchema, avatarUploadSchema } from "./profile.schema.js";
import * as profileService from "./profile.service.js";

export async function getProfile(req, res) {
  res.json(await profileService.getProfile(req.user.user_id));
}

export async function updateProfile(req, res) {
  const body = updateProfileSchema.parse(req.body);
  res.json(await profileService.updateProfile(req.user.user_id, body));
}

export async function avatarUploadUrl(req, res) {
  const { content_type } = avatarUploadSchema.parse(req.body);
  res.json(await profileService.createAvatarUploadUrl(req.user.user_id, content_type));
}

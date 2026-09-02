import {
  uploadUrlSchema,
  createResourceSchema,
  updateResourceSchema,
} from "./courses.schema.js";
import * as courseService from "./courses.service.js";

/* ── Catalogue ── */
export async function listCourses(req, res) {
  res.json(await courseService.listLocalCourses());
}

export async function getCourse(req, res) {
  res.json(await courseService.getCourse(req.params.courseRef));
}

export async function syncCourses(req, res) {
  res.json(await courseService.syncCoursesFromCms(req.user.user_id, req.ip));
}

/* ── Predefined resources (per course) ── */
export async function listCourseResources(req, res) {
  res.json(await courseService.listCourseResources(req.params.courseRef));
}

export async function courseResourceUploadUrl(req, res) {
  const body = uploadUrlSchema.parse(req.body);
  res.json(await courseService.createCourseResourceUploadUrl(req.params.courseRef, {
    fileName: body.file_name,
    contentType: body.content_type,
  }));
}

export async function createCourseResource(req, res) {
  const body = createResourceSchema.parse(req.body);
  res.status(201).json(
    await courseService.createCourseResource(req.params.courseRef, body, req.user.user_id, req.ip)
  );
}

/* ── Supplementary resources (per training run) ── */
export async function listTrainingResources(req, res) {
  res.json(await courseService.listTrainingResources(req.params.trainingRef));
}

export async function trainingResourceUploadUrl(req, res) {
  const body = uploadUrlSchema.parse(req.body);
  res.json(await courseService.createTrainingResourceUploadUrl(req.params.trainingRef, {
    fileName: body.file_name,
    contentType: body.content_type,
  }));
}

export async function createTrainingResource(req, res) {
  const body = createResourceSchema.parse(req.body);
  res.status(201).json(
    await courseService.createTrainingResource(req.params.trainingRef, body, req.user.user_id, req.ip)
  );
}

/* ── Shared resource ops ── */
export async function updateResource(req, res) {
  const body = updateResourceSchema.parse(req.body);
  res.json(await courseService.updateResource(req.params.resourceId, body, req.user.user_id, req.ip));
}

export async function deleteResource(req, res) {
  res.json(await courseService.deleteResource(req.params.resourceId, req.user.user_id, req.ip));
}

/* ── Enrolled-learner / trainer read ── */
export async function myTrainingResources(req, res) {
  // Admins and trainers may read any training's resources; learners must be
  // enrolled. Role comes from the verified JWT.
  const role = req.user.role;
  res.json(await courseService.listResourcesForTraining(req.params.trainingRef, {
    userId: req.user.user_id,
    requireEnrolment: role === "learner" || role === "sponsor",
  }));
}

import { listCoursesQuerySchema, listSchedulesQuerySchema } from "./cms.schema.js";
import * as cmsService from "./cms.service.js";

export async function listCourses(req, res) {
  const filters = listCoursesQuerySchema.parse(req.query);
  res.json(await cmsService.listCourses(filters));
}

export async function listSchedules(req, res) {
  const { country } = listSchedulesQuerySchema.parse(req.query);
  res.json(await cmsService.listSchedules(req.params.courseSlug, { country }));
}

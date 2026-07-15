import { reportQuerySchema, reportRecordsQuerySchema } from "./reports.schema.js";
import * as reportsService from "./reports.service.js";

export async function getSalesReport(req, res) {
  const filters = reportQuerySchema.parse(req.query);
  res.json(await reportsService.getSalesReport(filters));
}

export async function getSalesRecords(req, res) {
  const filters = reportRecordsQuerySchema.parse(req.query);
  res.json(await reportsService.getSalesRecords(filters));
}

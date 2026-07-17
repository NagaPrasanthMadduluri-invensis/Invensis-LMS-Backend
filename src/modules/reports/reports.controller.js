import {
  reportQuerySchema,
  reportRecordsQuerySchema,
  attendanceReportQuerySchema,
} from "./reports.schema.js";
import * as reportsService from "./reports.service.js";

export async function getSalesReport(req, res) {
  const filters = reportQuerySchema.parse(req.query);
  res.json(await reportsService.getSalesReport(filters));
}

export async function getSalesRecords(req, res) {
  const filters = reportRecordsQuerySchema.parse(req.query);
  res.json(await reportsService.getSalesRecords(filters));
}

const csvCell = (v) => {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLS = [
  "training_code",
  "training_title",
  "day_number",
  "session_start",
  "participant_name",
  "participant_email",
  "status",
  "marked_at",
];

export async function getAttendanceReport(req, res) {
  const { training_id, format } = attendanceReportQuerySchema.parse(req.query);
  const rows = await reportsService.getAttendanceRecords({ training_id });

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="attendance.csv"');
    res.write(COLS.join(",") + "\n");
    for (const r of rows) res.write(COLS.map((c) => csvCell(r[c])).join(",") + "\n"); // streamed
    return res.end();
  }
  res.json({ records: rows });
}

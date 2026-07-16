import * as ticketService from "./tickets.service.js";
import {
  createTicketSchema,
  updateTicketSchema,
  listTicketsQuerySchema,
} from "./tickets.schema.js";

/* ── Learner ── */

export async function learnerCreate(req, res) {
  const body = createTicketSchema.parse(req.body);
  const result = await ticketService.createTicket(req.user.user_id, body, req.ip);
  res.status(201).json(result);
}

export async function learnerList(req, res) {
  res.json(await ticketService.listLearnerTickets(req.user.user_id));
}

export async function learnerGet(req, res) {
  res.json(await ticketService.getLearnerTicket(req.user.user_id, req.params.ticketId));
}

/* ── Admin ── */

export async function adminList(req, res) {
  const query = listTicketsQuerySchema.parse(req.query);
  res.json(await ticketService.listAdminTickets(query));
}

export async function adminGet(req, res) {
  res.json(await ticketService.getAdminTicket(req.params.ticketId));
}

export async function adminUpdate(req, res) {
  const body = updateTicketSchema.parse(req.body);
  res.json(
    await ticketService.updateTicketStatus(req.user.user_id, req.params.ticketId, body, req.ip)
  );
}

import * as sponsorService from "./sponsor.service.js";

export async function getDashboard(req, res) {
  res.json(await sponsorService.getDashboard(req.user.user_id));
}

export async function listSponsoredLearners(req, res) {
  res.json(await sponsorService.listSponsoredLearners(req.user.user_id));
}

export async function listInvoices(req, res) {
  res.json(await sponsorService.listInvoices(req.user.user_id));
}

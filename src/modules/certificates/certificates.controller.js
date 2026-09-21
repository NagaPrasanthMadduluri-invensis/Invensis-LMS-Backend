import * as svc from "./certificates.service.js";
import {
  generateCertificatesSchema,
  releaseCertificatesSchema,
  revokeCertificateSchema,
  setTrainingPdusSchema,
  updateCertificateSchema,
} from "./certificates.schema.js";

export async function listAll(_req, res) {
  res.json(await svc.listAllCertificates());
}

export async function listTrainings(_req, res) {
  res.json(await svc.listCertifiableTrainings());
}

export async function trainingDetail(req, res) {
  res.json(await svc.getTrainingCertificates(req.params.trainingRef));
}

export async function generate(req, res) {
  const body = generateCertificatesSchema.parse(req.body ?? {});
  const result = await svc.generateCertificates(
    req.user.user_id, req.params.trainingRef, body.enrolment_ids, req.ip
  );
  res.status(201).json({ result });
}

export async function release(req, res) {
  const body = releaseCertificatesSchema.parse(req.body ?? {});
  const result = await svc.releaseCertificates(
    req.user.user_id, req.params.trainingRef, body.enrolment_ids, req.ip
  );
  res.json({ result });
}

export async function revoke(req, res) {
  const body = revokeCertificateSchema.parse(req.body ?? {});
  const result = await svc.revokeCertificate(
    req.user.user_id, req.params.certificateId, body.reason, req.ip
  );
  res.json({ result });
}

export async function setPdus(req, res) {
  const body = setTrainingPdusSchema.parse(req.body);
  const result = await svc.setTrainingPdus(
    req.user.user_id, req.params.trainingRef, body, req.ip
  );
  res.json({ result });
}

export async function update(req, res) {
  const body = updateCertificateSchema.parse(req.body);
  const result = await svc.updateCertificate(
    req.user.user_id, req.params.certificateId, body, req.ip
  );
  res.json({ result });
}

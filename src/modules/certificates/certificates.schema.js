import { z } from "zod";
import { CERTIFICATE_MODES } from "../../lib/certificates.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Optional list of enrolment ids. Absent/empty = act on the whole training.
const enrolmentIds = z.array(z.string().uuid()).optional();

export const generateCertificatesSchema = z.object({ enrolment_ids: enrolmentIds });
export const releaseCertificatesSchema = z.object({ enrolment_ids: enrolmentIds });

export const revokeCertificateSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * PDUs awarded for a training, the PMI claim code, and the printed mode.
 *
 * All three are OPTIONAL. Most trainings are not PMI-accredited and have no
 * PDUs or claim code to award, so requiring them blocked certificate
 * generation for the majority; the certificate simply omits the fields it has
 * no value for. `certificate_mode` unset keeps the wording derived from the
 * training's delivery mode.
 *
 * Optional does not mean unchecked: when a PDU count IS given it must fall in
 * 8-60, the range the business issues. Anything outside that is a typo rather
 * than a real award, and a wrong PDU count on a certificate is a compliance
 * problem — so it is still rejected rather than stored.
 *
 * `null` is distinct from absent: null CLEARS a stored value, absent leaves it
 * untouched. That is what lets an admin remove a claim code entered by mistake
 * without also wiping the PDUs.
 */
export const setTrainingPdusSchema = z
  .object({
    pdus: z
      .number()
      .int()
      .min(8, "PDUs must be at least 8")
      .max(60, "PDUs cannot exceed 60")
      .nullable()
      .optional(),
    pdu_claim_code: z.string().trim().min(3).max(40).nullable().optional(),
    certificate_mode: z.enum(CERTIFICATE_MODES).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

/**
 * Admin correction of an issued certificate.
 *
 * Course title and session dates are NOT here on purpose: they come from the
 * training, so a certificate can never state something the training doesn't.
 * `learner_name` accepts null to clear the override and fall back to the
 * participant record — that is how a wrong edit is undone.
 */
export const updateCertificateSchema = z
  .object({
    learner_name: z.string().trim().min(1).max(200).nullable().optional(),
    certificate_code: z.string().trim().min(3).max(40).optional(),
    course_identifier: z.string().trim().max(60).nullable().optional(),
    pdus: z.number().int().min(8).max(60).nullable().optional(),
    pdu_claim_code: z.string().trim().min(3).max(40).nullable().optional(),
    issued_at: z.string().datetime({ offset: true }).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

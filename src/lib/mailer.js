/**
 * Outbound email — Nodemailer SMTP with a console fallback.
 *
 * If SMTP_HOST is configured, mail is sent over SMTP. Otherwise (local/CI) the
 * transport logs the message to the console so the flow is fully exercisable
 * without credentials. Call sites don't change either way.
 */
import nodemailer from "nodemailer";
import { env } from "../config/env.js";

// Blind-copied on every outgoing email for oversight.
const MAIL_BCC = "operations@invensislearning.com";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE, // true for 465, false for 587/STARTTLS
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  } else {
    // No SMTP configured — log instead of send.
    transporter = {
      sendMail: async (msg) => {
        console.log(
          `[mailer:console] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`
        );
        return { messageId: "console" };
      },
    };
  }
  return transporter;
}

async function sendMail({ to, cc, subject, text, html }) {
  const msg = { from: env.MAIL_FROM, to, bcc: MAIL_BCC, subject, text, html };
  if (cc) msg.cc = cc; // optional CC (e.g. a learner's sponsor on info emails)
  await getTransporter().sendMail(msg);
  return msg;
}

const BRAND_LOGO = "https://media.invensislearning.com/Invensis-learning-logo.png";

// Shared dark footer (brand, social, contact, address, legal). Static — no
// per-email values — so it lives outside the shell function.
const EMAIL_FOOTER = `<tr><td style="background:#101030;padding:30px 34px 26px;text-align:center;">
  <p style="margin:0 0 16px;font:700 15px/1.4 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#ffffff;">Connect with Invensis Learning</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 20px;"><tbody><tr><td style="padding:0 5px;"><a href="https://www.linkedin.com/company/invensis-learning" style="text-decoration:none;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td width="34" height="34" align="center" valign="middle" bgcolor="#0A66C2" style="border-radius:50%;font:700 13px/34px 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#ffffff;">L</td></tr></tbody></table></a></td><td style="padding:0 5px;"><a href="https://www.youtube.com/@invensislearning" style="text-decoration:none;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td width="34" height="34" align="center" valign="middle" bgcolor="#FF0000" style="border-radius:50%;font:700 13px/34px 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#ffffff;">Y</td></tr></tbody></table></a></td><td style="padding:0 5px;"><a href="https://x.com/invensislearn" style="text-decoration:none;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td width="34" height="34" align="center" valign="middle" bgcolor="#000000" style="border-radius:50%;font:700 13px/34px 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#ffffff;">X</td></tr></tbody></table></a></td><td style="padding:0 5px;"><a href="https://www.facebook.com/invensislearning" style="text-decoration:none;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td width="34" height="34" align="center" valign="middle" bgcolor="#1877F2" style="border-radius:50%;font:700 13px/34px 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#ffffff;">F</td></tr></tbody></table></a></td></tr></tbody></table>
  <p style="margin:0 0 4px;font:400 12.5px/1.5 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#aeb6d6;">For any query, contact us at</p>
  <p style="margin:0 0 16px;font:600 13px/1.5 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;"><a href="mailto:help@invensislearning.com" style="color:#F8981C;text-decoration:none;">help@invensislearning.com</a></p>
  <div style="font:400 11px/1.7 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#8f98c0;max-width:470px;margin:0 auto 16px;"><div style="margin:0 0 4px;"><strong style="color:#c3c9dd;">USA/Canada:</strong> +1 470-260-0084  |  <strong style="color:#c3c9dd;">Switzerland:</strong> +41 22 518 20 42  |  <strong style="color:#c3c9dd;">Australia:</strong> +61 2 5300 2805</div><div style="margin:0 0 4px;"><strong style="color:#c3c9dd;">Netherlands:</strong> +31 20 262 2348  |  <strong style="color:#c3c9dd;">Belgium:</strong> +32 2 585 31 34  |  <strong style="color:#c3c9dd;">Denmark:</strong> +32 2 585 31 34</div><div style="margin:0 0 4px;"><strong style="color:#c3c9dd;">Poland:</strong> +48 91 883 47 51  |  <strong style="color:#c3c9dd;">UK:</strong> +44 20 3322 3280  |  <strong style="color:#c3c9dd;">India:</strong> +91 96202-00784</div></div>
  <p style="margin:0 0 18px;font:400 11.5px/1.6 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#aeb6d6;">Invensis Inc., 2785 Rockbrook Dr STE 204, Lewisville, TX 75067, United States</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tbody><tr><td height="1" style="background:#2a2a55;font-size:0;line-height:0;"> </td></tr></tbody></table>
  <p style="margin:16px 0 12px;font:400 11px/1.9 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#8f98c0;">
    <a href="https://www.invensislearning.com/terms-and-conditions" style="color:#8f98c0;">Terms &amp; Conditions</a>  |
    <a href="https://www.invensislearning.com/privacy-policy" style="color:#8f98c0;">Privacy Policy</a>  |
    <a href="https://www.invensislearning.com/refund-policy" style="color:#8f98c0;">Refund Policy</a>  |
    <a href="https://www.invensislearning.com/rescheduling-policy" style="color:#8f98c0;">Rescheduling Policy</a></p>
  <p style="margin:0;font:400 10.5px/1.6 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#6f78a0;">Copyright © 2026 Invensis Inc. All rights reserved.<br>This is a service email relating to your account with Invensis Inc.</p>
</td></tr>`;

const FONT = "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

// Branded, email-client-safe outer chrome (dark logo header, orange accent rule,
// Plus Jakarta Sans, dark footer). Every email shares this; only `contentHtml` —
// the block inside the padded body cell — changes per message.
function renderEmail({ subject, preheader, contentHtml }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${subject}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
@media only screen and (max-width:620px){ .wrap{width:100%!important} .pad{padding:26px 20px!important} h1{font-size:26px!important} }
a{color:#018BD4}
</style></head>
<body style="margin:0;padding:0;background:#f4f7fb;">
<div style="display:none;font-size:1px;color:#f4f7fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f7fb;"><tbody><tr><td align="center" style="padding:30px 12px;">
<table role="presentation" class="wrap" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(16,16,48,.07);">
<tbody>
<tr><td style="padding:20px 34px;">
  <img src="${BRAND_LOGO}" alt="Invensis Learning" width="180" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:180px;">
</td></tr>
<tr><td style="height:4px;background:#F8981C;font-size:0;line-height:0;"> </td></tr>
<tr><td class="pad" style="padding:32px 34px 34px;">
${contentHtml}
</td></tr>
${EMAIL_FOOTER}
</tbody></table>
</td></tr></tbody></table>
</body></html>`;
}

// Token emails (account setup, password reset): eyebrow + heading + one body
// paragraph + a single CTA whose link expires, with a paste-the-link fallback.
function emailShell({ subject, preheader, eyebrow, heading, greeting, body, buttonLabel, link }) {
  const contentHtml = `<div style="margin:0 0 20px;">
  <p style="margin:0 0 9px;font:800 11px/1 ${FONT};letter-spacing:.15em;text-transform:uppercase;color:#F8981C;">${eyebrow}</p>
  <h1 style="margin:0;font:800 30px/1.15 ${FONT};color:#101030;letter-spacing:-.01em;">${heading}</h1>
</div>
<p style="margin:0 0 16px;font:400 16px/1.65 ${FONT};color:#374151;">${greeting}</p>
<p style="margin:0 0 22px;font:400 16px/1.65 ${FONT};color:#374151;">${body}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 22px;"><tbody>
  <tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td align="center" bgcolor="#F8981C" style="border-radius:10px;"><a href="${link}" style="display:inline-block;padding:15px 34px;font:800 14.5px/1 ${FONT};color:#101030;text-decoration:none;border-radius:10px;letter-spacing:.01em;">${buttonLabel} →</a></td></tr></tbody></table></td></tr>
  <tr><td align="center" style="padding:11px 0 0;font:500 11.5px/1.5 ${FONT};color:#6b7280;">This link is valid for ${env.SETUP_TOKEN_TTL_HOURS} hours</td></tr>
</tbody></table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 4px;background:#f4f7fb;border:1px solid #e5e7eb;border-radius:11px;"><tbody><tr><td style="padding:14px 16px;">
  <p style="margin:0 0 5px;font:700 10.5px/1 ${FONT};letter-spacing:.1em;text-transform:uppercase;color:#6b7280;">Button not working?</p>
  <p style="margin:0;font:400 13px/1.6 ${FONT};color:#374151;word-break:break-all;">Paste this link into your browser:<br><a href="${link}" style="color:#018BD4;">${link}</a></p>
</td></tr></tbody></table>
<p style="margin:26px 0 0;font:400 15px/1.6 ${FONT};color:#374151;">Warm regards,<br><strong style="color:#101030;">The Invensis Learning Team</strong></p>`;
  return renderEmail({ subject, preheader, contentHtml });
}

/* ── Cohort-update email content blocks (shared visual language) ── */
const cohortHead = (eyebrow, heading, sub) =>
  `<div style="margin:0 0 18px;">
  <p style="margin:0 0 9px;font:800 11px/1 ${FONT};letter-spacing:.15em;text-transform:uppercase;color:#F8981C;">${eyebrow}</p>
  <h1 style="margin:0;font:800 28px/1.18 ${FONT};color:#101030;letter-spacing:-.01em;">${heading}</h1>${sub ? `
  <p style="margin:9px 0 0;font:500 14px/1.5 ${FONT};color:#6b7280;">${sub}</p>` : ""}
</div>`;
const cohortPara = (html) =>
  `<p style="margin:0 0 18px;font:400 16px/1.65 ${FONT};color:#374151;">${html}</p>`;
const cohortButton = (label, url) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 22px;"><tbody><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td align="center" bgcolor="#F8981C" style="border-radius:10px;"><a href="${url}" style="display:inline-block;padding:15px 34px;font:800 14.5px/1 ${FONT};color:#101030;text-decoration:none;border-radius:10px;letter-spacing:.01em;">${label} →</a></td></tr></tbody></table></td></tr></tbody></table>`;
const cohortTable = (title, rows) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 20px;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;overflow:hidden;"><tbody>
  <tr><td colspan="2" style="padding:11px 16px;background:#f4f7fb;font:700 11px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:#018BD4;border-bottom:1px solid #e5e7eb;">${title}</td></tr>
  ${rows.map(([label, value], i) => `<tr><td width="42%" style="padding:11px 16px;font:500 13px/1.5 ${FONT};color:#6b7280;${i < rows.length - 1 ? "border-bottom:1px solid #eef0f5;" : ""}">${label}</td><td style="padding:11px 16px;font:600 13px/1.5 ${FONT};color:#101030;${i < rows.length - 1 ? "border-bottom:1px solid #eef0f5;" : ""}">${value}</td></tr>`).join("")}
</tbody></table>`;
const cohortChecklist = (title, items) =>
  `<p style="margin:2px 0 10px;font:800 11px/1 ${FONT};letter-spacing:.1em;text-transform:uppercase;color:#F8981C;">${title}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;"><tbody>${items.map((it) => `<tr><td style="padding:4px 0;font:400 14px/1.55 ${FONT};color:#374151;"><span style="color:#018BD4;font-weight:700;">&#10003;</span>&nbsp;&nbsp;${it}</td></tr>`).join("")}</tbody></table>`;
const cohortNote = (html) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;background:#f4f7fb;border-left:3px solid #018BD4;border-radius:6px;"><tbody><tr><td style="padding:14px 18px;font:400 13.5px/1.5 ${FONT};color:#374151;">${html}</td></tr></tbody></table>`;
const cohortAmber = (html) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;background:#FFF8EE;border:1px solid #F8D9A6;border-radius:8px;"><tbody><tr><td style="padding:13px 16px;font:400 13px/1.5 ${FONT};color:#7A4A00;">${html}</td></tr></tbody></table>`;
const cohortSignoff = (line, name) =>
  `<p style="margin:24px 0 0;font:400 15px/1.6 ${FONT};color:#374151;">${line}<br><strong style="color:#101030;">${name}</strong></p>`;
const firstNameOf = (name) => (name || "").trim().split(/\s+/)[0] || "there";

// K1 — meeting/join link released to the cohort's learners.
export async function sendJoinLinkEmail(recipient, ctx) {
  const first = firstNameOf(recipient.name);
  const dashboardUrl = `${env.FRONTEND_URL}/dashboard`;
  const subject = `Your join link for ${ctx.courseName} is ready, ${first}`;
  const text =
    `Hi ${first},\n\n` +
    `Your session link for ${ctx.courseName} (Cohort ${ctx.batchCode}) is now live. ` +
    `Join every session of this cohort from your Invensis Learning dashboard:\n${dashboardUrl}\n\n` +
    `Starts: ${ctx.startLine}\nTrainer: ${ctx.trainerName}\n\n` +
    `See you in class,\nThe Invensis Learning Cohort Team`;
  const contentHtml =
    cohortHead("Cohort Logistics", `Your join link is here, ${first}`, `${ctx.courseName} · Cohort ${ctx.batchCode}`) +
    cohortPara(`Your session link for <strong>${ctx.courseName}</strong> (Cohort ${ctx.batchCode}) is now live. Join every session of this cohort from your Invensis Learning dashboard.`) +
    cohortButton("Go to my dashboard", dashboardUrl) +
    cohortTable("Cohort details", [
      ["Course", ctx.courseName],
      ["Batch code", ctx.batchCode],
      ["Starts", ctx.startLine],
      ["Ends", ctx.endDate],
      ["Format", ctx.format],
      ["Trainer", ctx.trainerName],
    ]) +
    cohortChecklist("Before day 1", [
      "Test your camera, mic and speakers",
      "Join five minutes early on Day 1",
      "Add all cohort dates to your calendar",
    ]) +
    cohortNote(`<strong>Something not working?</strong> Reply to this email and we'll sort it out.`) +
    cohortSignoff("See you in class,", "The Invensis Learning Cohort Team");
  return sendMail({
    to: recipient.email,
    cc: recipient.cc, // learner's sponsor, when available (undefined otherwise)
    subject,
    text,
    html: renderEmail({ subject, preheader: "Your session link for this cohort is live in your dashboard.", contentHtml }),
  });
}

// K2 — trainer assigned to the training.
export async function sendTrainerAssignedEmail(recipient, ctx) {
  const first = firstNameOf(recipient.name);
  const subject = `Your trainer for ${ctx.courseName} is assigned, ${first}`;
  const text =
    `Hi ${first},\n\n` +
    `${ctx.trainerName} will be your trainer for ${ctx.courseName} (Cohort ${ctx.batchCode}). You'll meet them on Day 1.\n\n` +
    `Have a question for the trainer? Reply and we'll pass it on before Day 1.\n\n` +
    `See you soon,\nThe Invensis Learning Cohort Team`;
  const contentHtml =
    cohortHead("Trainer Update", `Your trainer is assigned, ${first}`, `${ctx.courseName} · Cohort ${ctx.batchCode}`) +
    cohortPara(`<strong>${ctx.trainerName}</strong> will be your trainer for <strong>${ctx.courseName}</strong> (Cohort ${ctx.batchCode}). You'll meet them on Day 1.`) +
    cohortNote(`<strong>Have a question for the trainer?</strong> Reply and we'll pass it on before Day 1.`) +
    cohortSignoff("See you soon,", "The Invensis Learning Cohort Team");
  return sendMail({
    to: recipient.email,
    cc: recipient.cc, // learner's sponsor, when available (undefined otherwise)
    subject,
    text,
    html: renderEmail({ subject, preheader: `${ctx.trainerName} will be your trainer for this cohort. You'll meet them on Day 1.`, contentHtml }),
  });
}

// K3 — cohort rescheduled (dates moved).
export async function sendCohortRescheduledEmail(recipient, ctx) {
  const first = firstNameOf(recipient.name);
  const dashboardUrl = `${env.FRONTEND_URL}/dashboard`;
  const subject = `Your ${ctx.batchCode} cohort dates have moved, ${first}`;
  const text =
    `Hi ${first},\n\n` +
    `The ${ctx.batchCode} cohort dates have moved.\n\n` +
    `Previous dates: ${ctx.oldStart} → ${ctx.oldEnd}\n` +
    `New dates: ${ctx.newStart} → ${ctx.newEnd}\n` +
    `Reason: ${ctx.reason}\n\n` +
    `Your enrolment, price, syllabus and dashboard access are unchanged. ` +
    `View the updated schedule: ${dashboardUrl}\n\n` +
    `New dates don't fit? Reply and we'll move you to another cohort, no fees.\n\n` +
    `Thank you for your flexibility,\nThe Invensis Learning Cohort Team`;
  const contentHtml =
    cohortHead("Schedule Update", "Your cohort has been rescheduled", `${ctx.courseName} · Cohort ${ctx.batchCode}`) +
    cohortAmber(`<strong>Heads up:</strong> your training dates have changed. Nothing else has.`) +
    cohortPara(`Hi ${first},<br><br>The <strong>${ctx.batchCode}</strong> cohort dates have moved. Here's what's changed.`) +
    cohortTable("What's changing", [
      ["Previous dates", `<span style="color:#6b7280;text-decoration:line-through;">${ctx.oldStart} → ${ctx.oldEnd}</span>`],
      ["New dates", `<span style="color:#018BD4;font-weight:700;">${ctx.newStart} → ${ctx.newEnd}</span>`],
      ["Reason", ctx.reason],
    ]) +
    cohortChecklist("What stays the same", [
      "Your enrolment and price",
      "Your syllabus, materials and certificate on completion",
      "Your dashboard access and learning resources",
    ]) +
    cohortButton("View updated schedule", dashboardUrl) +
    cohortNote(`<strong>New dates don't fit?</strong> Reply and we'll move you to another cohort, no fees.`) +
    cohortSignoff("Thank you for your flexibility,", "The Invensis Learning Cohort Team");
  return sendMail({
    to: recipient.email,
    cc: recipient.cc, // learner's sponsor, when available (undefined otherwise)
    subject,
    text,
    html: renderEmail({ subject, preheader: "New dates, same course, same trainer — here's what changes.", contentHtml }),
  });
}

export async function sendAccountSetupEmail(user, link) {
  const subject = "Set up your Invensis Learning Portal account";
  const text =
    `Hi ${user.name},\n\n` +
    `An account has been created for you on Invensis Learning Portal. ` +
    `Set your password to activate it (link valid ${env.SETUP_TOKEN_TTL_HOURS} hours):\n\n` +
    `${link}\n\n` +
    `If you weren't expecting this, you can safely ignore this email.`;
  const html = emailShell({
    subject,
    preheader: "Set your password to activate your Invensis Learning Portal account.",
    eyebrow: "Account Setup",
    heading: "Welcome to Invensis Learning Portal",
    greeting: `Hi ${user.name},`,
    body: "An account has been created for you. Set your password below to activate it and start using your dashboard.",
    buttonLabel: "Set Your Password",
    link,
  });
  await sendMail({ to: user.email, subject, text, html });
}

export async function sendPasswordResetEmail(user, link) {
  const subject = "Reset your Invensis Learning Portal password";
  const text =
    `Hi ${user.name},\n\n` +
    `We received a request to reset your password. ` +
    `Use the link below (valid ${env.SETUP_TOKEN_TTL_HOURS} hours):\n\n` +
    `${link}\n\n` +
    `If you didn't request this, you can safely ignore this email.`;
  const html = emailShell({
    subject,
    preheader: "Reset your Invensis Learning Portal password.",
    eyebrow: "Password Reset",
    heading: "Reset your password",
    greeting: `Hi ${user.name},`,
    body: "We received a request to reset your password. If this was you, use the button below to choose a new one.",
    buttonLabel: "Reset Password",
    link,
  });
  await sendMail({ to: user.email, subject, text, html });
}

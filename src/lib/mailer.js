/**
 * Outbound email — Nodemailer SMTP with a console fallback.
 *
 * If SMTP_HOST is configured, mail is sent over SMTP. Otherwise (local/CI) the
 * transport logs the message to the console so the flow is fully exercisable
 * without credentials. Call sites don't change either way.
 */
import nodemailer from "nodemailer";
import { env } from "../config/env.js";

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

async function sendMail({ to, subject, text, html }) {
  await getTransporter().sendMail({ from: env.MAIL_FROM, to, subject, text, html });
}

const BRAND_LOGO = "https://media.invensislearning.com/invensis-learning-logo.svg";

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

// Branded, email-client-safe HTML shell matching the Invensis Learning template
// (dark header + logo, orange accent rule, Plus Jakarta Sans, branded footer).
// Only the content differs per email; the layout/style is shared.
function emailShell({ subject, preheader, eyebrow, heading, greeting, body, buttonLabel, link }) {
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
<tr><td style="background:#101030;padding:20px 34px;">
  <img src="${BRAND_LOGO}" alt="Invensis Learning" width="180" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:180px;">
</td></tr>
<tr><td style="height:4px;background:#F8981C;font-size:0;line-height:0;"> </td></tr>
<tr><td class="pad" style="padding:32px 34px 34px;">
<div style="margin:0 0 20px;">
  <p style="margin:0 0 9px;font:800 11px/1 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;letter-spacing:.15em;text-transform:uppercase;color:#F8981C;">${eyebrow}</p>
  <h1 style="margin:0;font:800 30px/1.15 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#101030;letter-spacing:-.01em;">${heading}</h1>
</div>
<p style="margin:0 0 16px;font:400 16px/1.65 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#374151;">${greeting}</p>
<p style="margin:0 0 22px;font:400 16px/1.65 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#374151;">${body}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 22px;"><tbody>
  <tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td align="center" bgcolor="#F8981C" style="border-radius:10px;"><a href="${link}" style="display:inline-block;padding:15px 34px;font:800 14.5px/1 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#101030;text-decoration:none;border-radius:10px;letter-spacing:.01em;">${buttonLabel} →</a></td></tr></tbody></table></td></tr>
  <tr><td align="center" style="padding:11px 0 0;font:500 11.5px/1.5 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#6b7280;">This link is valid for ${env.SETUP_TOKEN_TTL_HOURS} hours</td></tr>
</tbody></table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 4px;background:#f4f7fb;border:1px solid #e5e7eb;border-radius:11px;"><tbody><tr><td style="padding:14px 16px;">
  <p style="margin:0 0 5px;font:700 10.5px/1 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#6b7280;">Button not working?</p>
  <p style="margin:0;font:400 13px/1.6 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#374151;word-break:break-all;">Paste this link into your browser:<br><a href="${link}" style="color:#018BD4;">${link}</a></p>
</td></tr></tbody></table>
<p style="margin:26px 0 0;font:400 15px/1.6 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;color:#374151;">Warm regards,<br><strong style="color:#101030;">The Invensis Learning Team</strong></p>
</td></tr>
${EMAIL_FOOTER}
</tbody></table>
</td></tr></tbody></table>
</body></html>`;
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

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

function layout(heading, greeting, body, buttonLabel, link) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <h2 style="color:#111">${heading}</h2>
    <p>${greeting}</p>
    <p>${body}</p>
    <p style="margin:24px 0">
      <a href="${link}" style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${buttonLabel}</a>
    </p>
    <p style="font-size:13px;color:#555">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
    <p style="font-size:13px;color:#555">This link is valid for ${env.SETUP_TOKEN_TTL_HOURS} hours.</p>
  </div>`;
}

export async function sendAccountSetupEmail(user, link) {
  const subject = "Set up your Invensis Learning Portal account";
  const text =
    `Hi ${user.name},\n\n` +
    `An account has been created for you on Invensis Learning Portal. ` +
    `Set your password to activate it (link valid ${env.SETUP_TOKEN_TTL_HOURS} hours):\n\n` +
    `${link}\n\n` +
    `If you weren't expecting this, you can safely ignore this email.`;
  const html = layout(
    "Welcome to Invensis Learning Portal",
    `Hi ${user.name},`,
    "An account has been created for you. Set your password to activate it.",
    "Set your password",
    link
  );
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
  const html = layout(
    "Reset your password",
    `Hi ${user.name},`,
    "We received a request to reset your password. If this was you, continue below.",
    "Reset password",
    link
  );
  await sendMail({ to: user.email, subject, text, html });
}

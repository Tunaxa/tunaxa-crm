import nodemailer from "nodemailer";
import { isEmailConfigured } from "./config.js";
import { retryWithBackoff } from "./retry.js";

let transporter = null;

export function resetTransporter() {
  transporter = null;
}

function getTransporter(settings) {
  if (transporter) return transporter;
  const secure =
    settings.smtpSecure === true ||
    settings.smtpSecure === "true" ||
    Number(settings.smtpPort) === 465;
  transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort) || 587,
    secure,
    auth: { user: settings.smtpUser, pass: settings.smtpPass },
  });
  return transporter;
}

export async function sendEmail(settings, { to, subject, text, html }) {
  if (!isEmailConfigured(settings)) {
    return {
      delivered: false,
      status: "Saved",
      error: "SMTP is not configured in Settings",
    };
  }
  try {
    const info = await retryWithBackoff(
      () =>
        getTransporter(settings).sendMail({
          from: `"${settings.workspaceName || "Tunaxa"}" <${settings.smtpUser}>`,
          to,
          subject,
          text,
          html,
        }),
      { attempts: 2 },
    );
    return {
      delivered: true,
      status: "Sent",
      providerId: info.messageId || "",
    };
  } catch (error) {
    return { delivered: false, status: "Failed", error: error.message };
  }
}

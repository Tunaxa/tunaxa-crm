import nodemailer from "nodemailer";
import { isEmailConfigured } from "./config.js";
import { retryWithBackoff } from "./retry.js";

let transporter = null;
let activeProvider = "smtp";

export function resetTransporter() {
  transporter = null;
}

function buildTransporter(settings) {
  const provider = String(settings.emailProvider || "smtp");

  if (provider === "resend" && settings.resendApiKey) {
    activeProvider = "resend";
    return nodemailer.createTransport({
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      auth: { user: "resend", pass: settings.resendApiKey },
    });
  }

  if (provider === "sendgrid" && settings.sendgridApiKey) {
    activeProvider = "sendgrid";
    return nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      secure: false,
      auth: { user: "apikey", pass: settings.sendgridApiKey },
    });
  }

  if (provider === "ses" && settings.sesRegion) {
    activeProvider = "ses";
    return nodemailer.createTransport({
      host: `email-smtp.${settings.sesRegion}.amazonaws.com`,
      port: Number(settings.sesPort) || 587,
      secure: false,
      auth: {
        user: settings.sesAccessKey || "",
        pass: settings.sesSecretKey || "",
      },
    });
  }

  activeProvider = "smtp";
  const secure =
    settings.smtpSecure === true ||
    settings.smtpSecure === "true" ||
    Number(settings.smtpPort) === 465;
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort) || 587,
    secure,
    auth: { user: settings.smtpUser, pass: settings.smtpPass },
  });
}

function getTransporter(settings) {
  if (transporter) return transporter;
  transporter = buildTransporter(settings);
  return transporter;
}

const fromAddress = (settings) =>
  settings.emailFrom ||
  `"${settings.workspaceName || "Tunaxa"}" <${settings.smtpUser || settings.emailSender || "no-reply@tunaxa.app"}>`;

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
          from: fromAddress(settings),
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
      provider: activeProvider,
    };
  } catch (error) {
    return { delivered: false, status: "Failed", error: error.message };
  }
}

export function testProvider(settings) {
  try {
    const t = buildTransporter(settings);
    const provider = activeProvider;
    return t
      .verify()
      .then(() => ({ ok: true, provider }))
      .catch((err) => ({ ok: false, provider, error: err.message }));
  } catch (err) {
    return Promise.resolve({ ok: false, provider: "smtp", error: err.message });
  }
}

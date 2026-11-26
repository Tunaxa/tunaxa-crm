import dns from "node:dns/promises";
import net from "node:net";

const MAX_URL_LENGTH = 2048;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function normalizeHostname(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function isBlockedIpv4(address) {
  if (!net.isIPv4(address)) return false;
  const parts = address.split(".").map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first, second] = parts;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first >= 224) return true;
  return false;
}

function firstHextet(address) {
  const clean = address.split("%")[0].toLowerCase();
  const halves = clean.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length > 1
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  return Number.parseInt(groups[0] || "0", 16);
}

function isBlockedIpv6(address) {
  const clean = address.split("%")[0].toLowerCase();
  if (clean === "::" || clean === "::1") return true;
  const mapped = clean.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/u);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const first = firstHextet(clean);
  if (!Number.isFinite(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isBlockedAddress(address) {
  if (typeof address !== "string" || !address.trim()) return true;
  const value = address.trim();
  const version = net.isIP(value);
  if (version === 4) return isBlockedIpv4(value);
  if (version === 6) return isBlockedIpv6(value);
  return false;
}

function isBlockedHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  return isBlockedAddress(host);
}

export async function assertSafeWebhookUrl(value) {
  if (typeof value !== "string") throw new Error("Invalid webhook URL");
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_URL_LENGTH ||
    hasControlCharacters(trimmed) ||
    /\s/u.test(trimmed)
  ) {
    throw new Error("Invalid webhook URL");
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Invalid webhook URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Webhook URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Webhook URL must not contain credentials");
  }

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("Webhook destination is not allowed");
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Webhook destination could not be resolved");
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("Webhook destination is not allowed");
  }

  return trimmed;
}

export async function readBoundedResponse(response, limit = MAX_RESPONSE_BYTES) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) {
      throw new Error("Webhook response too large");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Webhook response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

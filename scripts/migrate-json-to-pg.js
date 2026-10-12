#!/usr/bin/env node
import crypto from "node:crypto";
import { readDb } from "../backend/store.js";
import { getPool, closePool } from "../backend/db/pg.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE = "tunaxa-crm";

function toUuid(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const stripped = raw.replace(/^[a-z]+_/i, "");
  if (UUID_RE.test(stripped)) return stripped.toLowerCase();
  const digest = crypto.createHash("sha256").update(`${NAMESPACE}:${raw.toLowerCase()}`).digest("hex");
  const version = ((parseInt(digest[12], 16) & 0x0f) | 0x4).toString(16);
  const variant = ((parseInt(digest[16], 16) & 0x3f) | 0x80).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${version}${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function splitName(name) {
  if (name === null || name === undefined) return { first_name: null, last_name: null };
  const trimmed = String(name).trim();
  if (!trimmed) return { first_name: null, last_name: null };
  const space = trimmed.indexOf(" ");
  if (space === -1) return { first_name: trimmed, last_name: null };
  const last = trimmed.slice(space + 1).trim();
  return { first_name: trimmed.slice(0, space), last_name: last || null };
}

function toNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : String(value);
}

function slugify(value) {
  const out = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return out || null;
}

function customFieldsFrom(source, keys) {
  const out = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

async function insertRows(client, table, columns, rows, conflictKey = "id") {
  let inserted = 0;
  for (const row of rows) {
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const values = columns.map((c) => row[c]);
    const result = await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${conflictKey}) DO NOTHING`,
      values,
    );
    inserted += result.rowCount;
  }
  return inserted;
}

async function main() {
  const db = await readDb();
  const client = await getPool().connect();
  const logs = [];

  const workspaceOfUser = {};
  for (const user of db.users || []) {
    if (user.workspaceId && !workspaceOfUser[user.workspaceId]) workspaceOfUser[user.workspaceId] = user;
  }
  const workspaceIds = Object.keys(workspaceOfUser).sort();
  const settings = db.settings || {};
  const adminUser = (db.users || []).find((u) => u.email === "admin@tunaxa.com") || (db.users || [])[0];
  const adminWorkspaceId = adminUser && adminUser.workspaceId;
  const defaultWorkspaceId = toUuid(adminWorkspaceId) || toUuid(workspaceIds[0]);

  try {
    await client.query("BEGIN");

    const workspaceRows = workspaceIds.map((workspaceId) => {
      const owner = workspaceOfUser[workspaceId];
      const isAdmin = workspaceId === adminWorkspaceId;
      const name = isAdmin ? settings.workspaceName || "Default Workspace" : `${owner && owner.name ? `${owner.name} workspace` : "Workspace"}`;
      const slug = slugify(name) || `ws-${toUuid(workspaceId).slice(0, 8)}`;
      return {
        id: toUuid(workspaceId),
        name,
        slug,
        settings,
        created_at: (owner && owner.createdAt) || null,
        updated_at: (owner && (owner.updatedAt || owner.createdAt)) || null,
      };
    });

    const userRows = (db.users || []).map((user) => ({
      id: toUuid(user.id),
      email: user.email,
      password_hash: user.password,
      name: user.name || null,
      role: user.role || "user",
      created_at: user.createdAt || null,
      updated_at: user.updatedAt || user.createdAt || null,
    }));

    const sessionRows = (db.sessions || []).map((session) => ({
      token: session.token,
      user_id: toUuid(session.userId),
      expires_at: toDate(session.expiresAt),
      created_at: session.createdAt || null,
      updated_at: session.createdAt || null,
    }));

    const companyByName = new Map();
    const companyRows = (db.companies || []).map((company) => {
      const id = toUuid(company.id);
      companyByName.set(company.name, id);
      return {
        id,
        workspace_id: defaultWorkspaceId,
        name: company.name,
        domain: null,
        industry: company.industry || null,
        size: null,
        custom_fields: customFieldsFrom(company, ["website", "country", "employees"]),
        created_at: company.createdAt || null,
        updated_at: company.updatedAt || company.createdAt || null,
      };
    });

    const contactByEmail = new Map();
    const contactRows = (db.contacts || []).map((contact) => {
      const id = toUuid(contact.id);
      if (contact.email) contactByEmail.set(contact.email, id);
      const parts = splitName(contact.name);
      return {
        id,
        workspace_id: defaultWorkspaceId,
        company_id: contact.company ? companyByName.get(contact.company) || null : null,
        first_name: parts.first_name,
        last_name: parts.last_name,
        email: contact.email || null,
        phone: contact.phone || null,
        title: contact.role || null,
        owner_id: null,
        custom_fields: {},
        created_at: contact.createdAt || null,
        updated_at: contact.updatedAt || contact.createdAt || null,
      };
    });

    const leadRows = (db.leads || []).map((lead) => {
      const parts = splitName(lead.name);
      return {
        id: toUuid(lead.id),
        workspace_id: defaultWorkspaceId,
        first_name: parts.first_name,
        last_name: parts.last_name,
        email: lead.email || null,
        phone: lead.phone || null,
        company_name: lead.company || null,
        status: lead.status || null,
        source: lead.source || null,
        value: toNum(lead.value),
        owner_id: null,
        custom_fields: {},
        created_at: lead.createdAt || null,
        updated_at: lead.updatedAt || lead.createdAt || null,
      };
    });

    const dealRows = (db.deals || []).map((deal) => ({
      id: toUuid(deal.id),
      workspace_id: defaultWorkspaceId,
      contact_id: null,
      company_id: deal.company ? companyByName.get(deal.company) || null : null,
      owner_id: null,
      title: deal.title,
      value: toNum(deal.value),
      stage: deal.stage,
      expected_close_date: toDate(deal.closeDate),
      custom_fields: {},
      created_at: deal.createdAt || null,
      updated_at: deal.updatedAt || deal.createdAt || null,
    }));

    const taskRows = (db.tasks || []).map((task) => ({
      id: toUuid(task.id),
      workspace_id: defaultWorkspaceId,
      assigned_to: null,
      contact_id: null,
      deal_id: null,
      title: task.title,
      description: null,
      status: task.status || "pending",
      due_date: toDate(task.dueDate),
      created_at: task.createdAt || null,
      updated_at: task.updatedAt || task.createdAt || null,
    }));

    const metadataKeys = ["date", "source", "callId", "messageId", "recordId", "meetingLinkId", "workflowId", "ticketId", "phone"];
    const activityRows = (db.activities || []).map((activity) => ({
      id: toUuid(activity.id),
      workspace_id: defaultWorkspaceId,
      user_id: null,
      contact_id: activity.contact ? contactByEmail.get(activity.contact) || null : null,
      deal_id: null,
      type: activity.type || "Note",
      subject: activity.title || null,
      body: activity.notes || null,
      direction: null,
      metadata: customFieldsFrom(activity, metadataKeys),
      created_at: activity.createdAt || null,
      updated_at: activity.updatedAt || activity.createdAt || null,
    }));

    const tableColumns = {
      workspaces: ["id", "name", "slug", "settings", "created_at", "updated_at"],
      users: ["id", "email", "password_hash", "name", "role", "created_at", "updated_at"],
      sessions: ["token", "user_id", "expires_at", "created_at", "updated_at"],
      companies: ["id", "workspace_id", "name", "domain", "industry", "size", "custom_fields", "created_at", "updated_at"],
      contacts: ["id", "workspace_id", "company_id", "first_name", "last_name", "email", "phone", "title", "owner_id", "custom_fields", "created_at", "updated_at"],
      leads: ["id", "workspace_id", "first_name", "last_name", "email", "phone", "company_name", "status", "source", "value", "owner_id", "custom_fields", "created_at", "updated_at"],
      deals: ["id", "workspace_id", "contact_id", "company_id", "owner_id", "title", "value", "stage", "expected_close_date", "custom_fields", "created_at", "updated_at"],
      tasks: ["id", "workspace_id", "assigned_to", "contact_id", "deal_id", "title", "description", "status", "due_date", "created_at", "updated_at"],
      activities: ["id", "workspace_id", "user_id", "contact_id", "deal_id", "type", "subject", "body", "direction", "metadata", "created_at", "updated_at"],
    };

    const allRows = { workspaces: workspaceRows, users: userRows, sessions: sessionRows, companies: companyRows, contacts: contactRows, leads: leadRows, deals: dealRows, tasks: taskRows, activities: activityRows };
    const order = ["workspaces", "users", "sessions", "companies", "contacts", "leads", "deals", "tasks", "activities"];

    for (const table of order) {
      const rows = allRows[table];
      const conflictKey = table === "sessions" ? "token" : "id";
      const inserted = await insertRows(client, table, tableColumns[table], rows, conflictKey);
      const read = rows.length;
      logs.push({ table, read, inserted, skipped: read - inserted });
      console.log(`[${table}] read=${read} inserted=${inserted} skipped=${read - inserted}`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return logs;
}

try {
  await main();
} catch (error) {
  console.error("[migrate:data] failed:", error.message);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
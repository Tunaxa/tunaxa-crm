import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
let dbFile = process.env.TEST_DB_PATH || path.join(root, 'data', 'db.json');
let queue = Promise.resolve();
let ensurePromise = null;

export const EMPTY_DB = {
  users: [],
  sessions: [],
  leads: [],
  contacts: [],
  companies: [],
  deals: [],
  tasks: [],
  activities: [],
  workflows: [],
  calls: [],
  recordings: [],
  messages: [],
  userNotifications: [],
  sequences: [],
  sequenceEnrollments: [],
  team: [],
  invitations: [],
  emailOutbox: [],
  customFields: [],
  audit: [],
  lists: [],
  tickets: [],
  articles: [],
  revisions: [],
  webVisits: [],
  chatConversations: [],
  meetingLinks: [],
  leadScoringRules: [],
  stageGates: {},
  forms: [],
  executionQueue: [],
  campaigns: [],
  emailLists: [],
  landingPages: [],
  products: [],
  orders: [],
  invoices: [],
  expenses: [],
  employees: [],
  leaveRequests: [],
  attendance: [],
  quotes: [],
  contracts: [],
  marketingEmails: [],
  marketingEvents: [],
  goals: [],
  surveys: [],
  surveyResponses: [],
  webhookEndpoints: [],
  webhookDeliveries: [],
  integrations: {},
  settings: {},
  meta: { seedVersion: 0 },
};

function ensureDbFile() {
  if (!ensurePromise) {
    const target = dbFile;
    ensurePromise = (async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.access(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try {
          await fs.writeFile(target, JSON.stringify(EMPTY_DB, null, 2), {
            flag: 'wx',
          });
        } catch (writeError) {
          if (writeError.code !== 'EEXIST') throw writeError;
        }
      }
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

export function setDbPath(newPath) {
  dbFile = newPath;
  queue = Promise.resolve();
  ensurePromise = null;
  ensureDbFile().catch(() => {});
}

export function getDbPath() {
  return dbFile;
}

export async function readDb() {
  await queue;
  await ensureDbFile();
  const raw = await fs.readFile(dbFile, 'utf8');
  return JSON.parse(raw);
}

const REPLACE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function persist(contents) {
  const temp = `${dbFile}.tmp`;
  await fs.writeFile(temp, contents);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, dbFile);
      return;
    } catch (error) {
      if (!REPLACE_RETRY_CODES.has(error.code)) throw error;
      if (attempt >= 5) {
        await fs.writeFile(dbFile, contents);
        await fs.rm(temp, { force: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export function writeDb(data) {
  queue = queue.then(async () => {
    await ensureDbFile();
    await persist(JSON.stringify(data, null, 2));
  });
  return queue;
}

export function mutateDb(mutator) {
  const task = queue.then(async () => {
    await ensureDbFile();
    const raw = await fs.readFile(dbFile, "utf8");
    const db = JSON.parse(raw);
    const result = await mutator(db);
    await persist(JSON.stringify(db, null, 2));
    return result;
  });
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

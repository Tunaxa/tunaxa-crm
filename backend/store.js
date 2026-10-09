import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
let dbFile = path.join(root, 'data', 'db.json');
let queue = Promise.resolve();

export function setDbPath(newPath) {
  dbFile = newPath;
  queue = Promise.resolve();
}

export function getDbPath() {
  return dbFile;
}

// Windows holds a lock on a file for a short window after a read/close, so an
// atomic rename over an existing db.json can fail with EPERM (or EBUSY) if a
// concurrent read or an antivirus scanner still has a handle on it. Retrying the
// rename is the standard remedy and keeps the write idempotent.
async function writeJsonFile(data) {
  const temp = `${dbFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, dbFile);
      return;
    } catch (error) {
      const retryable =
        error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY');
      if (!retryable || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function readDb() {
  await queue;
  const raw = await fs.readFile(dbFile, 'utf8');
  return JSON.parse(raw);
}

export function writeDb(data) {
  queue = queue.then(() => writeJsonFile(data));
  return queue;
}

export function mutateDb(mutator) {
  const task = queue.then(async () => {
    const raw = await fs.readFile(dbFile, 'utf8');
    const db = JSON.parse(raw);
    const result = await mutator(db);
    await writeJsonFile(db);
    return result;
  });
  queue = task.then(() => undefined, () => undefined);
  return task;
}

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

export async function readDb() {
  await queue;
  const raw = await fs.readFile(dbFile, 'utf8');
  return JSON.parse(raw);
}

export function writeDb(data) {
  queue = queue.then(async () => {
    const temp = `${dbFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2));
    await fs.rename(temp, dbFile);
  });
  return queue;
}

export function mutateDb(mutator) {
  const task = queue.then(async () => {
    const raw = await fs.readFile(dbFile, 'utf8');
    const db = JSON.parse(raw);
    const result = await mutator(db);
    const temp = `${dbFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify(db, null, 2));
    await fs.rename(temp, dbFile);
    return result;
  });
  queue = task.then(() => undefined, () => undefined);
  return task;
}

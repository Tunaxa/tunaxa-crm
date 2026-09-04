import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbFile = path.join(root, 'data', 'db.json');
const backupDir = path.join(root, 'backups');
const MAX_BACKUPS = 50;

export async function backupDb(label = '') {
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `db-${label ? `${label}-` : ''}${stamp}.json`);
  await fs.copyFile(dbFile, dest);
  const files = (await fs.readdir(backupDir)).filter(name => name.endsWith('.json')).sort();
  const extra = files.length - MAX_BACKUPS;
  if (extra > 0) {
    await Promise.all(files.slice(0, extra).map(name => fs.unlink(path.join(backupDir, name)).catch(() => {})));
  }
  return dest;
}

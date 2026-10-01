import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { SIGNATURE_BYTES, verifyMagicBytes } from '../services/fileSignature.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, '..', 'uploads');
const limiter = createRateLimiter({ windowMs: 60_000, max: 60, prefix: 'upload' });

const MAX_SIZE = 20 * 1024 * 1024;
const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
  'application/zip'
]);

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

// Read only the leading bytes of the temp file for signature inspection.
async function readHeader(filePath, length = SIGNATURE_BYTES) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function removeTempFiles(files) {
  await Promise.all((files || []).map(file => fs.unlink(file.path).catch(() => {})));
}

export default function registerUploadRoutes(app, upload) {
  app.post('/api/uploads', auth, requireRole('admin', 'member'), limiter, upload.array('files', 10), async (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'At least one file is required' });

    // Reject the whole request and clean up every temp file multer wrote.
    const fail = async (error) => {
      await removeTempFiles(req.files);
      return res.status(400).json({ error });
    };

    // Validate the entire batch before writing anything, so a spoofed upload
    // never leaves a stored record or an orphaned file behind.
    for (const file of req.files) {
      if (file.size > MAX_SIZE) {
        return fail(`Upload rejected: "${file.originalname}" exceeds the 20 MB limit`);
      }
      if (!ALLOWED.has(file.mimetype)) {
        return fail(`Upload rejected: file type not allowed (${file.mimetype})`);
      }

      let header;
      try {
        header = await readHeader(file.path);
      } catch {
        return fail(`Upload rejected: could not read "${file.originalname}"`);
      }

      // The client-declared mimetype is never trusted: the buffer's own
      // signature decides whether this is really an image/pdf/document.
      const check = verifyMagicBytes({
        buffer: header,
        mimetype: file.mimetype,
        filename: file.originalname,
      });
      if (!check.ok) return fail(check.error);
    }

    const saved = [];
    for (const file of req.files) {
      const ext = path.extname(file.originalname);
      const filename = `${id('file')}-${sanitize(path.basename(file.originalname, ext))}${ext}`;
      const dest = path.join(uploadDir, filename);
      await fs.rename(file.path, dest);

      const record = {
        id: id('upload'),
        filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: `/uploads/${filename}`,
        contact: req.body.contact || '',
        deal: req.body.deal || '',
        uploadedBy: req.user.name,
        createdAt: now(),
        updatedAt: now()
      };
      await mutateDb(db => {
        if (!db.uploads) db.uploads = [];
        db.uploads.unshift(record);
        db.audit.unshift({ id: id('audit'), action: `Uploaded file: ${file.originalname}`, actor: req.user.name, createdAt: now() });
      });
      saved.push(record);
    }
    res.status(201).json(saved);
  });

  app.get('/api/uploads', auth, limiter, async (req, res) => {
    const db = await (await import('../store.js')).readDb();
    let files = db.uploads || [];
    if (req.query.contact) files = files.filter(f => f.contact === req.query.contact);
    if (req.query.deal) files = files.filter(f => f.deal === req.query.deal);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    res.json({ items: files.slice(offset, offset + limit), total: files.length });
  });

  app.get('/api/uploads/:id', auth, limiter, async (req, res) => {
    const db = await (await import('../store.js')).readDb();
    const file = (db.uploads || []).find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
  });

  app.delete('/api/uploads/:id', auth, requireRole('admin', 'member'), limiter, async (req, res) => {
    let deleted = null;
    await mutateDb(db => {
      const index = (db.uploads || []).findIndex(f => f.id === req.params.id);
      if (index < 0) return;
      deleted = db.uploads[index];
      fs.unlink(path.join(uploadDir, deleted.filename)).catch(() => {});
      db.uploads.splice(index, 1);
      db.audit.unshift({ id: id('audit'), action: `Deleted file: ${deleted.originalName}`, actor: req.user.name, createdAt: now() });
    });
    if (!deleted) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true });
  });
}

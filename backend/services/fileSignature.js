/**
 * Magic-byte file type detection.
 *
 * The client-supplied MIME header and the file extension are both trivial to
 * forge (a Windows executable renamed to `photo.png` and sent with
 * `Content-Type: image/png` sails past a mimetype-only allowlist). This module
 * inspects the leading bytes of the uploaded file so the content itself decides
 * whether the upload is acceptable.
 *
 * `verifyMagicBytes()` compares the signature found in the buffer against the
 * type the client declared, and rejects the upload when they disagree - which
 * also rejects disguised executables, since their container signature is
 * recognised independently of the declared type.
 */

const SIGNATURE_BYTES = 4096;

const OLE2_COMPOUND_FILE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP_FIRST_BYTES = [0x50, 0x4b]; // "PK"

// Mach-O / universal binaries, read as a big-endian magic number.
const MACH_O_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[index] !== bytes[index]) return false;
  }
  return true;
}

function ascii(buffer, start, end) {
  return buffer.subarray(start, end).toString("latin1");
}

/**
 * Executable / binary program containers. Checked before any document or image
 * signature so a renamed binary is always reported as an executable.
 */
function detectExecutable(header) {
  if (startsWith(header, [0x4d, 0x5a])) {
    return { kind: 'executable', mime: 'application/x-msdownload', ext: 'exe', label: 'Windows PE/DOS executable' };
  }
  if (startsWith(header, [0x7f, 0x45, 0x4c, 0x46])) {
    return { kind: 'executable', mime: 'application/x-elf', ext: 'elf', label: 'ELF executable' };
  }
  if (header.length >= 4 && MACH_O_MAGICS.has(header.readUInt32BE(0))) {
    return { kind: 'executable', mime: 'application/x-mach-binary', ext: 'macho', label: 'Mach-O executable' };
  }
  if (startsWith(header, [0x64, 0x65, 0x78, 0x0a])) {
    return { kind: 'executable', mime: 'application/vnd.android.dex', ext: 'dex', label: 'Android DEX executable' };
  }
  if (startsWith(header, [0x23, 0x21])) {
    return { kind: 'executable', mime: 'text/x-script', ext: 'sh', label: 'script interpreter header' };
  }
  return null;
}

/** A buffer with no NUL bytes and few stray control bytes reads as text. */
export function isProbablyText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0x00) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return suspicious / buffer.length < 0.1;
}

function detectSvg(header) {
  if (!isProbablyText(header)) return null;
  const head = header.subarray(0, 2048).toString('utf8').toLowerCase();
  const match = head.match(/<svg[\s>/]/);
  if (!match) return null;
  return { kind: 'svg', mime: 'image/svg+xml', ext: 'svg' };
}

/**
 * Identify a file from its leading bytes.
 *
 * @param {Buffer} buffer Leading bytes of the file (a few KB is plenty).
 * @returns {{kind: string, mime: string, ext: string, label?: string}}
 */
export function detectFileSignature(buffer) {
  const header = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);

  const executable = detectExecutable(header);
  if (executable) return executable;

  if (startsWith(header, PNG)) {
    return { kind: 'png', mime: 'image/png', ext: 'png' };
  }
  if (startsWith(header, [0xff, 0xd8, 0xff])) {
    return { kind: 'jpeg', mime: 'image/jpeg', ext: 'jpg' };
  }
  if (startsWith(header, [0x47, 0x49, 0x46, 0x38])) {
    return { kind: 'gif', mime: 'image/gif', ext: 'gif' };
  }
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 12) === 'WEBP') {
    return { kind: 'webp', mime: 'image/webp', ext: 'webp' };
  }
  if (ascii(header, 0, 5) === '%PDF-') {
    return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  }
  if (startsWith(header, OLE2_COMPOUND_FILE)) {
    return { kind: 'ole2', mime: 'application/x-ole-storage', ext: 'ole' };
  }
  if (
    startsWith(header, ZIP_FIRST_BYTES) &&
    [0x03, 0x05, 0x07].includes(header[2]) &&
    [0x04, 0x06, 0x08].includes(header[3])
  ) {
    return { kind: 'zip', mime: 'application/zip', ext: 'zip' };
  }

  const svg = detectSvg(header);
  if (svg) return svg;

  if (isProbablyText(header)) {
    return { kind: 'text', mime: 'text/plain', ext: 'txt' };
  }

  return { kind: 'unknown', mime: 'application/octet-stream', ext: '' };
}

/** The signature family each accepted mimetype must resolve to. */
const EXPECTED_SIGNATURE = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/msword': 'ole2',
  'application/vnd.ms-excel': 'ole2',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
  'application/zip': 'zip',
  'text/csv': 'text',
  'text/plain': 'text',
};

/**
 * Verify an uploaded file against its declared type using magic bytes only.
 *
 * @param {{buffer: Buffer, mimetype?: string, filename?: string}} file
 * @returns {{ok: true, detected: object} | {ok: false, error: string, detected: object}}
 */
export function verifyMagicBytes(file = {}) {
  const declared = String(file.mimetype || '').toLowerCase();
  const name = String(file.filename || 'upload').slice(0, 80);
  const detected = detectFileSignature(file.buffer);
  const expected = EXPECTED_SIGNATURE[declared];

  if (detected.kind === 'executable') {
    return {
      ok: false,
      detected,
      error: `Upload rejected: "${name}" is a ${detected.label}, not ${declared || 'an allowed file type'}`,
    };
  }
  if (!expected) {
    return { ok: false, detected, error: `Upload rejected: file type not allowed (${declared || 'unknown'})` };
  }
  if (detected.kind !== expected) {
    return {
      ok: false,
      detected,
      error: `Upload rejected: "${name}" content (${detected.mime}) does not match its declared type (${declared})`,
    };
  }
  return { ok: true, detected };
}

export { SIGNATURE_BYTES };

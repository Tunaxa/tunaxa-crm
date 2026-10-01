import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/pg.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";
import { detectFileSignature, verifyMagicBytes } from "../services/fileSignature.js";

const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uploadsDir = path.join(backendDir, "uploads");

// Leading bytes are all that matters for signature detection.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(64)]);
const GIF = Buffer.from(`GIF89a${"".repeat(32)}`, "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBPVP8 ", "latin1")]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const OLE2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
const CSV = Buffer.from("name,email\nJane,jane@example.com\n");
const PE_EXECUTABLE = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]),
  Buffer.alloc(128),
]);
const ELF_EXECUTABLE = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(64)]);

let app, token;
const createdFiles = [];

async function countUploadDirFiles() {
  try {
    return (await fs.readdir(uploadsDir)).length;
  } catch {
    return 0;
  }
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await Promise.all(
    createdFiles.map((name) => fs.unlink(path.join(uploadsDir, name)).catch(() => {})),
  );
  await closePool();
});

describe("magic-byte detection", () => {
  it("identifies real image and document signatures", () => {
    expect(detectFileSignature(PNG).kind).toBe("png");
    expect(detectFileSignature(JPEG).kind).toBe("jpeg");
    expect(detectFileSignature(GIF).kind).toBe("gif");
    expect(detectFileSignature(WEBP).kind).toBe("webp");
    expect(detectFileSignature(PDF).kind).toBe("pdf");
    expect(detectFileSignature(ZIP).kind).toBe("zip");
    expect(detectFileSignature(OLE2).kind).toBe("ole2");
    expect(detectFileSignature(SVG).kind).toBe("svg");
    expect(detectFileSignature(CSV).kind).toBe("text");
  });

  it("flags executables regardless of the extension they carry", () => {
    expect(detectFileSignature(PE_EXECUTABLE).kind).toBe("executable");
    expect(detectFileSignature(ELF_EXECUTABLE).kind).toBe("executable");
  });

  it("accepts content that matches the declared type", () => {
    expect(verifyMagicBytes({ buffer: PNG, mimetype: "image/png", filename: "a.png" }).ok).toBe(true);
    expect(verifyMagicBytes({ buffer: PDF, mimetype: "application/pdf", filename: "a.pdf" }).ok).toBe(true);
    expect(verifyMagicBytes({ buffer: CSV, mimetype: "text/csv", filename: "a.csv" }).ok).toBe(true);
  });

  it("rejects a renamed executable and a type/content mismatch", () => {
    const exe = verifyMagicBytes({ buffer: PE_EXECUTABLE, mimetype: "image/png", filename: "invoice.png" });
    expect(exe.ok).toBe(false);
    expect(exe.error).toMatch(/executable/i);

    const mismatch = verifyMagicBytes({ buffer: JPEG, mimetype: "image/png", filename: "photo.png" });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toMatch(/does not match/i);

    const textAsImage = verifyMagicBytes({ buffer: CSV, mimetype: "image/png", filename: "graph.png" });
    expect(textAsImage.ok).toBe(false);
  });
});

describe("POST /api/uploads magic-byte enforcement", () => {
  it("accepts a genuine PNG", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body[0].mimeType).toBe("image/png");
    createdFiles.push(res.body[0].filename);
  });

  it("accepts a genuine PDF", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", PDF, { filename: "proposal.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    createdFiles.push(res.body[0].filename);
  });

  it("rejects a PE executable renamed to .png and leaves no temp file behind", async () => {
    const before = await countUploadDirFiles();
    const res = await request(app)
      .post("/api/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", PE_EXECUTABLE, { filename: "invoice.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/executable/i);
    expect(await countUploadDirFiles()).toBe(before);
  });

  it("rejects a JPEG declared as image/png", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", JPEG, { filename: "photo.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
  });

  it("rejects a text file declared as image/png", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", CSV, { filename: "graph.png", contentType: "image/png" });
    expect(res.status).toBe(400);
  });

  it("rejects the whole batch when one file is spoofed, storing nothing", async () => {
    const before = await countUploadDirFiles();
    const res = await request(app)
      .post("/api/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", PNG, { filename: "ok.png", contentType: "image/png" })
      .attach("files", PE_EXECUTABLE, { filename: "bad.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(await countUploadDirFiles()).toBe(before);

    const uploads = await request(app)
      .get("/api/uploads")
      .set("Authorization", `Bearer ${token}`);
    expect(uploads.body.items.some((item) => item.originalName === "ok.png")).toBe(false);
    expect(uploads.body.items.some((item) => item.originalName === "bad.png")).toBe(false);
  });
});

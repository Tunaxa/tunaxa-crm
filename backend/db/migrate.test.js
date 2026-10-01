import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), connect: vi.fn(), closePool: vi.fn(),
  readdir: vi.fn(), readFile: vi.fn(),
}));
vi.mock("./pg.js", () => ({
  getPool: () => ({ connect: mocks.connect }), closePool: mocks.closePool,
}));
vi.mock("node:fs/promises", () => ({
  default: { readdir: mocks.readdir, readFile: mocks.readFile },
}));
import { runMigrations } from "./migrate.js";
const connectionsOnImport = mocks.connect.mock.calls.length;

describe("migration runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.readdir.mockResolvedValue([
      { name: "002.sql", isFile: () => true },
      { name: "001.sql", isFile: () => true },
      { name: "README.md", isFile: () => true },
    ]);
    mocks.readFile.mockResolvedValue("SELECT 1;");
  });

  it("does not connect to a database when imported", () => {
    expect(connectionsOnImport).toBe(0);
  });

  it("runs unapplied SQL files in order and records each inside a transaction", async () => {
    mocks.query.mockImplementation(async (sql) => ({
      rows: sql === "SELECT filename FROM schema_migrations" ? [{ filename: "001.sql" }] : [],
    }));
    await runMigrations();
    // Only 002.sql is pending -> exactly one file read, in the right order.
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(mocks.readFile.mock.calls[0][0]).toMatch(/002\.sql$/);
    // The migration runs inside BEGIN/COMMIT and records its filename.
    expect(mocks.query).toHaveBeenCalledWith("BEGIN");
    expect(mocks.query).toHaveBeenCalledWith("SELECT 1;");
    expect(mocks.query).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)", ["002.sql"],
    );
    expect(mocks.query).toHaveBeenCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("releases the connection and does not record a failed migration", async () => {
    mocks.readFile.mockRejectedValue(new Error("Unreadable migration"));
    await expect(runMigrations()).rejects.toThrow("Unreadable migration");
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rolls back a migration whose SQL fails mid-execution", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql === "SELECT filename FROM schema_migrations") return { rows: [] };
      if (sql === "SELECT 1;") throw new Error("duplicate key");
      return { rows: [] };
    });
    await expect(runMigrations()).rejects.toThrow("Migration 001.sql failed: duplicate key");
    expect(mocks.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("is idempotent on an up-to-date database (skips everything, applies nothing)", async () => {
    mocks.query.mockImplementation(async (sql) => ({
      rows: sql === "SELECT filename FROM schema_migrations"
        ? [{ filename: "001.sql" }, { filename: "002.sql" }]
        : [],
    }));
    const result = await runMigrations();
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["001.sql", "002.sql"]);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalledWith("BEGIN");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
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

  it("runs only unapplied SQL files in order and records each filename", async () => {
    mocks.query.mockImplementation(async (sql) => ({
      rows: sql === "SELECT filename FROM schema_migrations" ? [{ filename: "001.sql" }] : [],
    }));
    await runMigrations();
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(mocks.readFile.mock.calls[0][0]).toMatch(/002\.sql$/);
    expect(mocks.query).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)", ["002.sql"],
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("releases the connection and does not record a failed migration", async () => {
    mocks.readFile.mockRejectedValue(new Error("Unreadable migration"));
    await expect(runMigrations()).rejects.toThrow("Unreadable migration");
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

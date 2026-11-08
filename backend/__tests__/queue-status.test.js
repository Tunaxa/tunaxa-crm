import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import { resetTestDb, cleanupTestDb, seedTestUser } from "./setup.js";
import { mutateDb } from "../store.js";

// `mockGetWebhookQueue` is referenced by the hoisted vi.mock factory, which is
// why it MUST be prefixed with `mock`.
const mockGetWebhookQueue = vi.fn();

vi.mock("../services/webhookQueue.js", () => ({
  getWebhookQueue: (...args) => mockGetWebhookQueue(...args),
  signPayload: vi.fn(),
  verifySignature: vi.fn(),
}));

let app;
let adminToken;
let memberToken;
let viewerToken;

async function seedUser(id, email, name, role) {
  const crypto = await import("node:crypto");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  const now = new Date().toISOString();
  await mutateDb((db) => {
    db.users.push({ id, name, email, password: `${salt}:${hash}`, role, createdAt: now });
    db.team.push({ id: `team_${id}`, name, email, role, status: "Active", createdAt: now });
  });
}

async function login(email) {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "test123" });
  expect(res.status).toBe(200);
  return res.body.token;
}

beforeAll(async () => {
  await resetTestDb();
  await seedTestUser(); // role "Owner" — treated as admin by requireRole
  await seedUser("usr_member", "member@test.com", "Member User", "member");
  await seedUser("usr_viewer", "viewer@test.com", "Viewer User", "viewer");
  const mod = await import("../server.js");
  app = mod.app;
  adminToken = await login("test@test.com");
  memberToken = await login("member@test.com");
  viewerToken = await login("viewer@test.com");
});

afterAll(() => cleanupTestDb());

beforeEach(() => {
  mockGetWebhookQueue.mockReset();
});

describe("GET /api/queue/status", () => {
  it("rejects non-admin roles (member, viewer) with 403", async () => {
    const memberRes = await request(app)
      .get("/api/queue/status")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(memberRes.status).toBe(403);

    const viewerRes = await request(app)
      .get("/api/queue/status")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(viewerRes.status).toBe(403);
  });

  it("gracefully returns zeros when Redis/BullMQ is not configured", async () => {
    mockGetWebhookQueue.mockReturnValue(null);

    const res = await request(app)
      .get("/api/queue/status")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      waiting: 0,
      active: 0,
      failed: 0,
      failedJobs: [],
      error: "Redis/BullMQ not configured",
    });
  });

  it("returns job counts and the last failed jobs for an admin", async () => {
    const failedJobs = Array.from({ length: 12 }, (_, i) => ({
      id: `job-${i}`,
      name: "deliver",
      failedReason: `Webhook returned 5${i % 10}: boom`,
      timestamp: 1_724_000_000_000 + i,
    }));
    mockGetWebhookQueue.mockReturnValue({
      getJobCounts: vi.fn().mockResolvedValue({ wait: 12, active: 3, failed: 2 }),
      getFailed: vi.fn().mockResolvedValue(failedJobs.slice(0, 10)),
    });

    const res = await request(app)
      .get("/api/queue/status")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.waiting).toBe(12);
    expect(res.body.active).toBe(3);
    expect(res.body.failed).toBe(2);
    expect(res.body.failedJobs).toHaveLength(10);
    expect(res.body.failedJobs[0]).toEqual({
      id: "job-0",
      name: "deliver",
      failedReason: failedJobs[0].failedReason,
      timestamp: failedJobs[0].timestamp,
    });
    expect(res.body.error).toBeUndefined();
  });

  it("fetches the last 10 failed jobs via getFailed(0, 9)", async () => {
    const fakeQueue = {
      getJobCounts: vi.fn().mockResolvedValue({ wait: 0, active: 0, failed: 0 }),
      getFailed: vi.fn().mockResolvedValue([]),
    };
    mockGetWebhookQueue.mockReturnValue(fakeQueue);

    const res = await request(app)
      .get("/api/queue/status")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(fakeQueue.getFailed).toHaveBeenCalledWith(0, 9);
  });
});
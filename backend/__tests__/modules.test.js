import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from "./setup.js";

let app;
let token;
let productId;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
}, 30000);

afterAll(() => cleanupTestDb());

describe("New module CRUD", () => {
  it("POST /api/campaigns creates a campaign", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Webinar Blast",
        channel: "Email",
        status: "Active",
        target: 5000,
        reached: 3000,
        leads: 120,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe("Webinar Blast");
  });

  it("POST /api/products coerces price/cost/stock strings to numbers", async () => {
    const res = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Starter Plan",
        price: "49.99",
        cost: "10",
        stock: "100",
        minStock: "5",
        status: "Active",
      });
    expect(res.status).toBe(201);
    expect(res.body.price).toBe(49.99);
    expect(res.body.cost).toBe(10);
    expect(res.body.stock).toBe(100);
    productId = res.body.id;
  });

  it("GET /api/products?q=Starter filters", async () => {
    const res = await request(app)
      .get("/api/products?q=Starter")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].price).toBe(49.99);
  });

  it("POST /api/employees coerces salary string to number", async () => {
    const res = await request(app)
      .post("/api/employees")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Ada Lovelace",
        email: "ada@tunaxa.app",
        department: "Engineering",
        salary: "120000",
        status: "Active",
      });
    expect(res.status).toBe(201);
    expect(res.body.salary).toBe(120000);
  });

  it("PUT /api/products/:id updates and DELETE removes", async () => {
    const upd = await request(app)
      .put(`/api/products/${productId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Starter Plan Pro", price: "59.99" });
    expect(upd.status).toBe(200);
    expect(upd.body.price).toBe(59.99);
    expect(upd.body.name).toBe("Starter Plan Pro");

    const del = await request(app)
      .delete(`/api/products/${productId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);

    const list = await request(app)
      .get("/api/products")
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.find((x) => x.id === productId)).toBeUndefined();
  });
});

describe("Module summary endpoints", () => {
  // Seed commerce + finance + hr data used by the summaries
  beforeAll(async () => {
    await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        orderNumber: "ORD-1",
        customer: "Acme",
        status: "Paid",
        subtotal: 100,
        tax: 8,
        shipping: 0,
        total: 108,
        items: "x1",
      });
    await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        orderNumber: "ORD-2",
        customer: "Globex",
        status: "Pending",
        subtotal: 200,
        tax: 16,
        shipping: 0,
        total: 216,
      });
    await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        number: "INV-1",
        customerName: "Acme",
        amount: 1000,
        status: "Paid",
      });
    await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        number: "INV-2",
        customerName: "Globex",
        amount: 500,
        status: "Pending",
      });
    await request(app)
      .post("/api/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Hosting",
        category: "Software",
        amount: 200,
        status: "Approved",
      });
    await request(app)
      .post("/api/leaveRequests")
      .set("Authorization", `Bearer ${token}`)
      .send({
        employee: "Ada Lovelace",
        type: "Vacation",
        days: 3,
        status: "Pending",
      });
  }, 30000);

  it("GET /api/marketing/summary aggregates campaigns", async () => {
    const res = await request(app)
      .get("/api/marketing/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toBe(1);
    expect(res.body.lists).toBe(0);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.conversionRate).toBeGreaterThan(0);
  });

  it("GET /api/commerce/summary computes revenue and averages", async () => {
    const res = await request(app)
      .get("/api/commerce/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.orders).toBe(2);
    expect(res.body.revenue).toBe(324); // 108 + 216
    expect(res.body.paidCount).toBe(1);
    expect(res.body.outstandingValue).toBe(216);
    expect(res.body.avgOrderValue).toBe(162);
  });

  it("GET /api/finance/summary returns issued, net and forecast", async () => {
    const res = await request(app)
      .get("/api/finance/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.issued).toBe(1500); // 1000 + 500
    expect(res.body.paidCount).toBe(1);
    expect(res.body.unpaidCount).toBe(1);
    expect(res.body.totalExpenses).toBe(200);
    expect(res.body.net).toBe(800); // 1000 - 200
    expect(res.body.monthly.length).toBeGreaterThanOrEqual(6);
    const last = res.body.monthly[res.body.monthly.length - 1];
    expect(last.revenue).toBe(1000); // paid invoice lands in current month
    expect(last.expenses).toBe(200);
    expect(res.body.forecast).toHaveLength(3);
    expect(res.body.forecast[0].projected).toBeGreaterThan(0);
  });

  it("GET /api/hr/summary counts employees and leave", async () => {
    const res = await request(app)
      .get("/api/hr/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.employees).toBe(1);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.leave).toBe(1);
    expect(res.body.pendingLeave).toBe(1);
    expect(res.body.byDepartment["Engineering"]).toBe(1);
  });

  it("summary endpoints require auth (401)", async () => {
    for (const ep of ["marketing", "commerce", "finance", "hr"]) {
      const res = await request(app).get(`/api/${ep}/summary`);
      expect(res.status).toBe(401);
    }
  });

  it("unknown module summary returns 404", async () => {
    const res = await request(app)
      .get("/api/unknownmodule/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("Generic CRUD protection on new resources", () => {
  it("GET /api/campaigns without token returns 401", async () => {
    const res = await request(app).get("/api/campaigns");
    expect(res.status).toBe(401);
  });

  it("POST /api/invoices rejects a non-object body with 400", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send([1, 2]);
    expect(res.status).toBe(400);
  });
});

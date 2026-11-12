import { afterAll, expect, it } from "vitest";
import "./setup.js";
import { closePool, query } from "../db/pg.js";

afterAll(closePool);

it("migrates core entities with compatible legacy ids and complete repository columns", async () => {
  const required = {
    contacts: ["id", "company_id", "owner_id", "custom_fields"],
    leads: ["id", "value", "owner_id", "custom_fields"],
    companies: ["id", "website", "country", "employees", "owner", "custom_fields"],
    deals: ["id", "contact_id", "company_id", "company", "contact", "pipeline_id", "owner", "custom_fields"],
    tasks: ["id", "contact_id", "deal_id", "completed", "priority", "owner", "source", "custom_fields"],
    activities: ["id", "contact_id", "deal_id", "title", "description", "record_id", "entity_id", "custom_fields"],
  };
  const result = await query(
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
    [Object.keys(required)],
  );
  for (const [table, columns] of Object.entries(required)) {
    const actual = result.rows.filter((row) => row.table_name === table);
    expect(actual.find((row) => row.column_name === "id")?.data_type).toBe("text");
    for (const column of columns) expect(actual.some((row) => row.column_name === column)).toBe(true);
    for (const pointer of ["contact_id", "company_id", "deal_id", "owner_id"]) {
      const column = actual.find((row) => row.column_name === pointer);
      if (column) expect(column.data_type).toBe("text");
    }
  }
});

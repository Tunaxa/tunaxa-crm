import { describe, it, expect } from "vitest";
import { legacyToPg, pgToLegacy } from "../legacy-shape.js";

describe("contact and lead property persistence", () => {
  for (const resource of ["contacts", "leads"]) {
    it(`preserves company and custom properties for ${resource}`, () => {
      const input = { name: "Ada Lovelace", company: "Analytical Engines", ownerId: "owner-1", favoriteColor: "blue" };
      const stored = legacyToPg(input, resource);
      expect(stored.first_name).toBe("Ada");
      expect(stored.last_name).toBe("Lovelace");
      expect(stored.owner_id).toBe("owner-1");
      expect(stored.custom_fields.favoriteColor).toBe("blue");
      if (resource === "leads") expect(stored.company_name).toBe(input.company);
      else expect(stored.custom_fields.company).toBe(input.company);
      expect(pgToLegacy(stored, resource)).toMatchObject(input);
      expect(input.name).toBe("Ada Lovelace");
    });
  }

  it("does not inject absent fields into a partial update", () => {
    expect(legacyToPg({ email: "ada@example.com" }, "contacts")).toEqual({ email: "ada@example.com" });
    expect(legacyToPg({ name: "Ada" }, "leads")).toEqual({ first_name: "Ada", last_name: "" });
  });
});

import { describe, expect, it } from "vitest";
import { userFormSchema } from "./formSchemas";

describe("userFormSchema", () => {
  it("accepts valid user data", () => {
    const result = userFormSchema.safeParse({
      name: "Nada",
      email: "nada@example.com",
      role: "user",
      description: "Utilisateur de test",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a name shorter than two characters", () => {
    const result = userFormSchema.safeParse({
      name: "N",
      email: "nada@example.com",
      role: "user",
      description: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = userFormSchema.safeParse({
      name: "Nada",
      email: "email-invalide",
      role: "user",
      description: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty role", () => {
    const result = userFormSchema.safeParse({
      name: "Nada",
      email: "nada@example.com",
      role: "",
      description: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a description longer than 500 characters", () => {
    const result = userFormSchema.safeParse({
      name: "Nada",
      email: "nada@example.com",
      role: "user",
      description: "a".repeat(501),
    });

    expect(result.success).toBe(false);
  });
});

const MANAGER_ROLES = new Set(["member", "admin", "owner"]);

export function canManageRecords(role: unknown): boolean {
  return typeof role === "string" && MANAGER_ROLES.has(role.trim().toLowerCase());
}

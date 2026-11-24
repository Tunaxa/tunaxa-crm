import { api, json } from "../../lib/api";

export function getPageSize(): number {
  const value = Number(localStorage.getItem("tunaxa.pageSize"));
  return Number.isInteger(value) && value >= 10 && value <= 100 ? value : 25;
}

export function savePageSize(pageSize: number): void {
  const value = Number(pageSize);
  if (!Number.isInteger(value) || value < 10 || value > 100) return;
  localStorage.setItem("tunaxa.pageSize", String(value));
  api("/users/me/preferences", json("PUT", { pageSize: value })).catch(() => {});
}

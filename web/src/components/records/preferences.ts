import { api, json } from "../../lib/api";

export function getPageSize() {
  const value = Number(localStorage.getItem("tunaxa.pageSize"));
  return Number.isInteger(value) && value > 0 ? value : 25;
}

export function savePageSize(pageSize: number) {
  localStorage.setItem("tunaxa.pageSize", String(pageSize));
  api("/users/me/preferences", json("PUT", { pageSize })).catch(() => {});
}

const MONEY_KEYS = new Set([
  "value",
  "amount",
  "budget",
  "price",
  "revenue",
  "total",
  "dealValue",
  "estimatedValue",
]);

export function showMoney(key: string): boolean {
  return MONEY_KEYS.has(key);
}



export const moneyKeys = new Set([
  "value",
  "price",
  "cost",
  "amount",
  "total",
  "subtotal",
  "tax",
  "shipping",
  "salary",
  "target",
  "reached",
]);

export const showMoney = (key: string) => moneyKeys.has(key);

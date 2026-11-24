export function isActivationKey(key: unknown): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

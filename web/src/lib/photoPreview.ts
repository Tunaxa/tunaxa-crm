// Only image sources supported by our upload/preview flow may reach img.src.
export function photoPreviewUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  if (/^\/(?:uploads|assets)\/[a-z0-9_./%-]+$/i.test(value) && !value.includes("..")) return value;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch { return undefined; }
  return undefined;
}

export function photoInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "NX";
}

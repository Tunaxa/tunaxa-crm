export type SignatureMode = "draw" | "type";

export function isSignatureReady({
  mode,
  typedName,
  hasDrawing,
  agreed,
}: {
  mode: SignatureMode;
  typedName: string;
  hasDrawing: boolean;
  agreed: boolean;
}) {
  return agreed && (mode === "draw" ? hasDrawing : Boolean(typedName.trim()));
}

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}

export function createTypedSignatureDataUrl(name: string) {
  const safeName = escapeXml(name.trim());
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="220" viewBox="0 0 720 220">',
    '<rect width="720" height="220" fill="white"/>',
    `<text x="360" y="130" text-anchor="middle" fill="#172033" font-size="64" font-family="Brush Script MT, Segoe Script, cursive">${safeName}</text>`,
    '<path d="M120 165 H600" stroke="#d6dce5" stroke-width="2"/>',
    "</svg>",
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

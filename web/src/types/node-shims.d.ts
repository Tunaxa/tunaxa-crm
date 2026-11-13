// Minimal ambient declarations for the Node built-ins used by the CSS
// integrity test. The repository intentionally does not depend on
// `@types/node` (see package.json), so only the narrow surface we call is
// typed here rather than pulling in the full Node type package.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

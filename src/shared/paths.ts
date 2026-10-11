import path from "node:path";

export function basename(p: string): string {
  return path.basename(p.replace(/\/+$/, "")) || p;
}

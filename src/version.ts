import fs from 'node:fs';
import path from 'node:path';

// Sniff the Claude Code version from the bundled entry source ("// Version: x.y.z").
export function sniffVersion(source: string): string | null {
  const head = source.slice(0, 8192);
  const m = head.match(/\/\/ Version:\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?)/);
  return m ? m[1] : null;
}

// This cc2js's own version (package.json sits one level above both src/ and dist/).
export function cc2jsVersion(): string {
  const p = path.join(__dirname, '..', 'package.json');
  return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version: string }).version;
}

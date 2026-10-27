import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from './app.js';

// Load .env from the repo root regardless of whether the process was started
// from /workspace or backend/ (npm workspaces vary the cwd).
const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(here, '../../../.env'), // backend/src|dist/... -> repo root
  path.resolve(here, '../../.env'),
]) {
  dotenv.config({ path: candidate });
}

const port = Number(process.env.PORT ?? 8787);
const app = createApp();
app.listen(port, () => {
  console.log(`[backend] Simple 2D Animation Studio API listening on http://localhost:${port}`);
});

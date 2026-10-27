import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const app = createApp();
app.listen(port, () => {
  console.log(`[backend] Simple 2D Animation Studio API listening on http://localhost:${port}`);
});

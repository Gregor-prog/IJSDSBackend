import app from "./app.js";
import { startCrossRefWorker } from "./src/lib/queue.js";
import { startIjsds2Workers } from "./src/modules/ijsds2/ijsds2.queue.js";

const PORT = 8080;

console.log("[startup] Node version:", process.version);
console.log("[startup] PORT:", PORT);
console.log("[startup] NODE_ENV:", process.env.NODE_ENV ?? "not set");
console.log("[startup] DATABASE_URL set:", !!process.env.DATABASE_URL);
console.log("[startup] JWT_SECRET set:", !!process.env.JWT_SECRET);
console.log("[startup] RESEND_API_KEY set:", !!process.env.RESEND_API_KEY);

app.listen(PORT,'0.0.0.0', () => {
  console.log(`[startup] Server running on port ${PORT}`);
  startCrossRefWorker();
  startIjsds2Workers().catch((err) => console.error("[ijsds2] worker startup failed:", err.message));
});

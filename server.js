import app from "./app.js";

const PORT = process.env.PORT || 8080;

console.log("[startup] Node version:", process.version);
console.log("[startup] PORT:", PORT);
console.log("[startup] NODE_ENV:", process.env.NODE_ENV ?? "not set");
console.log("[startup] DATABASE_URL set:", !!process.env.DATABASE_URL);
console.log("[startup] JWT_SECRET set:", !!process.env.JWT_SECRET);
console.log("[startup] RESEND_API_KEY set:", !!process.env.RESEND_API_KEY);

app.listen(PORT, () => {
  console.log(`[startup] Server running on port ${PORT}`);
});

import prismaClientPkg from "@prisma/client";
const { PrismaClient } = prismaClientPkg;

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Tells Node.js to accept Azure's SSL certificate
  },
  max: 5,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 50000,
});

pool.on("error", (err) => {
  console.error("[db] Pool error:", err.message);
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

console.log("[db] Prisma client initialised");

prisma
  .$connect()
  .then(() => console.log("[db] Connected to database"))
  .catch((err) => console.error("[db] Connection failed:", err.message));

export default prisma;

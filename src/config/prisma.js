import prismaClientPkg from '@prisma/client';
const { PrismaClient } = prismaClientPkg;

import prismaPgPkg from '@prisma/adapter-pg';
const { PrismaPg } = prismaPgPkg;

import pg from 'pg';

// Strip sslmode from the URL so the pool ssl option takes full control
const connectionString = (process.env.DATABASE_URL ?? '').replace(/[?&]sslmode=[^&]*/g, '');

const pool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] Pool error:', err.message);
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

console.log('[db] Prisma client initialised');

prisma.$connect()
  .then(() => console.log('[db] Connected to database'))
  .catch((err) => console.error('[db] Connection failed:', err.message));

export default prisma;

const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME     || 'gestion_parking',
        port:     parseInt(process.env.DB_PORT || '5432'),
        ssl:      false,
      }
);

pool.on('error', (err) => {
  console.error('[DB] Erreur pool inattendue :', err.message);
});

module.exports = pool;
import 'dotenv/config';
import mysql from 'mysql2/promise';

try {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  const [rows] = await pool.query('SHOW TABLES');
  console.log('✅ Connected! Tables found:');
  console.table(rows);
  process.exit(0);
} catch (err) {
  console.error('❌ Database connection failed:', err.message);
  process.exit(1);
}

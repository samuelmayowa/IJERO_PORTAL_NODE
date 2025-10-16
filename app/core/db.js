// app/core/db.js
// MySQL pool (both named and default export so all imports work)

import mysql from 'mysql2/promise';
import 'dotenv/config';

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ijero_node',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL || 10),
  queueLimit: 0,
});

// Export both ways so callers can do either:
//   import { pool } from '../core/db.js'
//   import pool from '../core/db.js'
export { pool };
export default pool;

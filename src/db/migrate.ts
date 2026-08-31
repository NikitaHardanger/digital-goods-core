import fs from 'node:fs/promises'; import { pool } from './index.js';
await pool.query(await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8')); await pool.end(); console.log('migrated');

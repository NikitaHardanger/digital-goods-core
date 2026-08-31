import app from './app.js'; import { pool } from './db/index.js';
await app.listen({port:Number(process.env.PORT??3000),host:'0.0.0.0'}); process.on('SIGTERM',async()=>{await app.close();await pool.end();});

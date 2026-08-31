import { pool } from './index.js';
const products = [
 ['STEAM-TOPUP-500','Пополнение Steam 500 ₽','topup',500], ['STEAM-TOPUP-1000','Пополнение Steam 1000 ₽','topup',1000], ['STEAM-TOPUP-2500','Пополнение Steam 2500 ₽','topup',2500],
 ['KEY-CS2-PRIME','CS2 Prime Status ключ','key',1290], ['KEY-GTA5','GTA V ключ активации','key',1990], ['KEY-EFT','Escape from Tarkov ключ','key',3490],
 ['SUB-DISCORD-1M','Discord Nitro 1 месяц','subscription',399], ['SUB-YT-3M','YouTube Premium 3 месяца','subscription',1490], ['SUB-SPOTIFY-1M','Spotify Premium 1 месяц','subscription',299],
 ['GIFT-PSN-1000','PlayStation Store карта 1000 ₽','giftcard',1000], ['GIFT-XBOX-1500','Xbox Gift Card 1500 ₽','giftcard',1500], ['GIFT-ROBLOX-800','Roblox 800 Robux','giftcard',890]
];
for (const [sku,name,type,price] of products) await pool.query('INSERT INTO products(sku,name,type,price,currency) VALUES($1,$2,$3,$4,$5) ON CONFLICT(sku) DO NOTHING',[sku,name,type,price,'RUB']);
await pool.end(); console.log('seeded');


import db from '../db.js';
export async function getUsers(req, res) {
  const data = await db.query('SELECT * FROM users');
  res.json(data);
}

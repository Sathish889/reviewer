export async function search(db, term) {
  return db.query('select id, name from merchants where name ilike $1', [`%${term}%`]);
}

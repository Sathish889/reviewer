export async function search(db, term, sort) {
  return db.query(`select id, name from merchants where name ilike '%${term}%' order by ${sort}`);
}

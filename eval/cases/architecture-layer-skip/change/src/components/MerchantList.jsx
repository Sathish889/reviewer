import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export function MerchantList() {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    pool.query('select id, name from merchants').then((r) => setRows(r.rows));
  }, []);
  return rows.map((m) => <li key={m.id}>{m.name}</li>);
}

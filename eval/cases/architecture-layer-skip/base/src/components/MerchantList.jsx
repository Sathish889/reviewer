import { listMerchants } from '../api/merchants.client.js';

export function MerchantList({ http }) {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => { listMerchants(http).then(setRows); }, [http]);
  return rows.map((m) => <li key={m.id}>{m.name}</li>);
}

'use strict';
// Cliente de Monday: cada colección es un tablero; cada registro, un item.
const API = 'https://api.monday.com/v2';
const FILE_API = 'https://api.monday.com/v2/file';

function makeMonday(token) {
  async function gql(query, variables) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) throw new Error('Monday: ' + JSON.stringify(j.errors || j.error_message || r.status).slice(0, 300));
    return j.data;
  }
  const toRec = (it, cols) => {
    const o = { id: String(it.id), nombre: it.name, ts: Date.parse(it.created_at) || 0 };
    for (const c of it.column_values) if (cols.includes(c.id)) o[c.id] = c.text == null ? '' : c.text;
    return o;
  };
  return {
    async list(board, cols, withAssets) {
      const q = (first) => `query($b:[ID!],$c:String){boards(ids:$b){items_page(limit:500,cursor:$c){cursor items{id name created_at ${withAssets ? 'assets(column_ids:["fotos"]){id}' : ''} column_values{id text}}}}}`;
      let out = [], cursor = null;
      do {
        const d = await gql(q(), { b: [board], c: cursor });
        const p = d.boards[0].items_page;
        for (const it of p.items) {
          const r = toRec(it, cols);
          if (withAssets) r.fotoIds = (it.assets || []).map((a) => String(a.id));
          out.push(r);
        }
        cursor = p.cursor;
      } while (cursor);
      return out;
    },
    async create(board, name, values) {
      const d = await gql('mutation($b:ID!,$n:String!,$v:JSON){create_item(board_id:$b,item_name:$n,column_values:$v){id created_at}}',
        { b: board, n: name || '-', v: JSON.stringify(values) });
      return { id: String(d.create_item.id), ts: Date.parse(d.create_item.created_at) || Date.now() };
    },
    async update(board, id, values, name) {
      if (name != null) await gql('mutation($b:ID!,$i:ID!,$v:JSON!){change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){id}}', { b: board, i: id, v: JSON.stringify({ name }) });
      if (Object.keys(values).length) await gql('mutation($b:ID!,$i:ID!,$v:JSON!){change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){id}}', { b: board, i: id, v: JSON.stringify(values) });
    },
    async remove(id) { await gql('mutation($i:ID!){delete_item(item_id:$i){id}}', { i: id }); },
    async upload(itemId, columnId, buf, filename, mime) {
      const fd = new FormData();
      fd.append('query', `mutation($file:File!){add_file_to_column(item_id:${Number(itemId)},column_id:"${columnId}",file:$file){id}}`);
      fd.append('variables[file]', new Blob([buf], { type: mime }), filename);
      const r = await fetch(FILE_API, { method: 'POST', headers: { Authorization: token }, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.errors) throw new Error('Monday upload: ' + JSON.stringify(j.errors || r.status).slice(0, 300));
      return String(j.data.add_file_to_column.id);
    },
    async asset(id) {
      const d = await gql('query($i:[ID!]!){assets(ids:$i){public_url name}}', { i: [id] });
      const u = d.assets[0] && d.assets[0].public_url;
      if (!u) return null;
      const r = await fetch(u);
      if (!r.ok) return null;
      return { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'image/jpeg' };
    },
  };
}
module.exports = { makeMonday };

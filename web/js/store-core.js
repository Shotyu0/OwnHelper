// Store interface shared by the Firestore and browser-only backends. Every path is relative to the
// signed-in user's root (users/{uid}/...). Times are stored as epoch milliseconds.
//
//   get(col, id)                     -> doc | null      (doc = {id, ...fields})
//   set(col, id, data)                                   replace
//   update(col, id, patch)                               merge; nested objects merge by field path
//   del(col, id)
//   query(col, {where, orderBy, limit}) -> docs          where: [[field, op, value]], op in == < <= > >=
//   count(col, where) -> number
//   batch([{op: 'set'|'update'|'del', col, id, data}])
//   watch(col, id, cb) -> unsubscribe                    live document
export const DELETE = Symbol('delete-field');
/** Atomic counter update: update(col, id, {reviews: inc(1)}). */
export const inc = n => ({ __inc: n });
export const isInc = v => v && typeof v === 'object' && typeof v.__inc === 'number';

const OPS = {
  '==': (a, b) => a === b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  '>': (a, b) => a > b, '>=': (a, b) => a >= b,
};

export function matches(doc, where = []) {
  return where.every(([f, op, v]) => doc[f] !== undefined && doc[f] !== null && OPS[op](doc[f], v)
    || (op === '==' && v === null && doc[f] == null));
}

/** Same semantics as Firestore for the queries this app makes (docs missing the orderBy field are excluded). */
export function runQuery(docs, { where = [], orderBy, limit } = {}) {
  let out = docs.filter(d => matches(d, where));
  if (orderBy) {
    const [f, dir = 'asc'] = orderBy;
    out = out.filter(d => d[f] !== undefined && d[f] !== null);
    out.sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  }
  return limit ? out.slice(0, limit) : out;
}

export function applyPatch(doc, patch) {
  const out = structuredClone(doc || {});
  for (const [k, v] of Object.entries(patch)) {
    if (v === DELETE) delete out[k];
    else if (isInc(v)) out[k] = (out[k] || 0) + v.__inc;
    else out[k] = v;
  }
  return out;
}

/** Browser-only backend (no Firebase configured): everything in localStorage on this device. */
export class LocalStore {
  constructor(prefix = 'ph:', storage = globalThis.localStorage) {
    this.prefix = prefix;
    this.storage = storage;
    this.watchers = new Map();
    this.mem = new Map();
  }
  _load(col) {
    if (!this.mem.has(col)) {
      let data = {};
      try { data = JSON.parse(this.storage?.getItem(this.prefix + col) || '{}'); } catch (_) { /* empty */ }
      this.mem.set(col, data);
    }
    return this.mem.get(col);
  }
  _save(col) {
    try { this.storage?.setItem(this.prefix + col, JSON.stringify(this._load(col))); } catch (_) { /* full/private */ }
    for (const [key, cbs] of this.watchers) if (key.startsWith(col + '/')) for (const cb of cbs) cb(this._doc(col, key.slice(col.length + 1)));
  }
  _doc(col, id) {
    const d = this._load(col)[id];
    return d ? { id, ...structuredClone(d) } : null;
  }
  async get(col, id) { return this._doc(col, id); }
  async set(col, id, data) { this._load(col)[id] = applyPatch({}, data); this._save(col); }
  async update(col, id, patch) { const c = this._load(col); c[id] = applyPatch(c[id], patch); this._save(col); }
  async del(col, id) { delete this._load(col)[id]; this._save(col); }
  async query(col, q = {}) {
    return runQuery(Object.entries(this._load(col)).map(([id, d]) => ({ id, ...structuredClone(d) })), q);
  }
  async count(col, where = []) { return (await this.query(col, { where })).length; }
  async batch(ops) {
    const touched = new Set();
    for (const o of ops) {
      const c = this._load(o.col);
      if (o.op === 'set') c[o.id] = applyPatch({}, o.data);
      else if (o.op === 'update') c[o.id] = applyPatch(c[o.id], o.data);
      else if (o.op === 'del') delete c[o.id];
      touched.add(o.col);
    }
    for (const col of touched) this._save(col);
  }
  watch(col, id, cb) {
    const key = col + '/' + id;
    if (!this.watchers.has(key)) this.watchers.set(key, new Set());
    this.watchers.get(key).add(cb);
    cb(this._doc(col, id));
    return () => this.watchers.get(key).delete(cb);
  }
}

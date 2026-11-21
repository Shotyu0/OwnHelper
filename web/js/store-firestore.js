// Firestore backend. Data lives under users/{uid}; firestore.rules only lets that uid in.
// Offline persistence is on, so the app keeps working at the gym with bad signal and syncs later.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, deleteDoc,
  collection, query, where, orderBy, limit, getDocs, getCountFromServer, writeBatch, onSnapshot, deleteField, increment,
} from 'firebase/firestore';
import { DELETE, isInc } from './store-core.js';

let app, auth, db;

export function initFirebase(cfg) {
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  return {
    onUser: cb => onAuthStateChanged(auth, cb),
    signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
    signOut: () => signOut(auth),
  };
}

const encode = (data, merge) => {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE) { if (merge) out[k] = deleteField(); }
    else if (isInc(v)) out[k] = increment(v.__inc);
    else out[k] = v;
  }
  return out;
};

// Writes don't wait for the server: Firestore applies them to the local cache at once (reads see them) and
// syncs when it can. Awaiting the server would freeze the page offline, e.g. logging sets at the gym.
export class FirestoreStore {
  constructor(uid, onError = console.error) {
    this.uid = uid;
    this.onError = onError;
  }
  _bg(p) { p.catch(this.onError); }
  ref(col, id) { return doc(db, 'users', this.uid, ...col.split('/'), id); }
  col(col) { return collection(db, 'users', this.uid, ...col.split('/')); }
  q(col, { where: w = [], orderBy: o, limit: l } = {}) {
    const parts = w.map(([f, op, v]) => where(f, op, v));
    if (o) parts.push(orderBy(o[0], o[1] || 'asc'));
    if (l) parts.push(limit(l));
    return query(this.col(col), ...parts);
  }
  async get(col, id) {
    const s = await getDoc(this.ref(col, id));
    return s.exists() ? { id: s.id, ...s.data() } : null;
  }
  async set(col, id, data) { this._bg(setDoc(this.ref(col, id), encode(data, false))); }
  async update(col, id, patch) { this._bg(setDoc(this.ref(col, id), encode(patch, true), { merge: true })); }
  async del(col, id) { this._bg(deleteDoc(this.ref(col, id))); }
  async query(col, q) {
    const s = await getDocs(this.q(col, q));
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async count(col, w = []) {
    try { return (await getCountFromServer(this.q(col, { where: w }))).data().count; }
    catch (_) { return (await getDocs(this.q(col, { where: w }))).size; }  // offline: count from the local cache
  }
  async batch(ops) {
    const b = writeBatch(db);
    for (const o of ops) {
      if (o.op === 'set') b.set(this.ref(o.col, o.id), encode(o.data, false));
      else if (o.op === 'update') b.set(this.ref(o.col, o.id), encode(o.data, true), { merge: true });
      else if (o.op === 'del') b.delete(this.ref(o.col, o.id));
    }
    this._bg(b.commit());
  }
  watch(col, id, cb) {
    return onSnapshot(this.ref(col, id), s => cb(s.exists() ? { id: s.id, ...s.data() } : null), () => cb(null));
  }
}

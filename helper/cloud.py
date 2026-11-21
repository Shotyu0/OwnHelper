"""Document store for the PC side: Firestore (users/{uid}/...) via a service account, or in-memory for tests.

Same conventions as the web app (web/js/store-core.js): times are epoch ms, paths are relative to the user root.
"""
from __future__ import annotations

import copy
import itertools
import operator
import threading
from typing import Callable

OPS = {"==": operator.eq, "<": operator.lt, "<=": operator.le, ">": operator.gt, ">=": operator.ge}


class Increment:
    def __init__(self, n: float):
        self.n = n


def _matches(doc: dict, where) -> bool:
    for f, op, v in where:
        x = doc.get(f)
        if v is None and op == "==":
            if x is not None:
                return False
        elif x is None or not OPS[op](x, v):
            return False
    return True


class MemoryStore:
    """In-memory store with Firestore-like query semantics, for tests."""

    def __init__(self):
        self.data: dict[str, dict[str, dict]] = {}
        self._ids = itertools.count(1)
        self._watchers: list[tuple[str, list, Callable]] = []
        self._doc_watchers: list[tuple[str, str, Callable]] = []

    def _notify(self, col: str, id_: str):
        for c, where, cb in self._watchers:
            if c == col:
                cb(self.query(col, where))
        for c, i, cb in self._doc_watchers:
            if c == col and i == id_:
                cb(self.get(col, id_))

    def get(self, col, id_):
        d = self.data.get(col, {}).get(id_)
        return {"id": id_, **copy.deepcopy(d)} if d is not None else None

    def set(self, col, id_, data):
        self.data.setdefault(col, {})[id_] = {k: v for k, v in copy.deepcopy(data).items()}
        self._notify(col, id_)

    def update(self, col, id_, patch):
        doc = self.data.setdefault(col, {}).setdefault(id_, {})
        for k, v in patch.items():
            doc[k] = doc.get(k, 0) + v.n if isinstance(v, Increment) else copy.deepcopy(v)
        self._notify(col, id_)

    def add(self, col, data) -> str:
        id_ = f"auto{next(self._ids)}"
        self.set(col, id_, data)
        return id_

    def delete(self, col, id_):
        self.data.get(col, {}).pop(id_, None)
        self._notify(col, id_)

    def query(self, col, where=(), order_by=None, limit=None):
        docs = [{"id": i, **copy.deepcopy(d)} for i, d in self.data.get(col, {}).items() if _matches(d, where)]
        if order_by:
            f, direction = order_by
            docs = [d for d in docs if d.get(f) is not None]
            docs.sort(key=lambda d: d[f], reverse=direction == "desc")
        return docs[:limit] if limit else docs

    def count(self, col, where=()):
        return len(self.query(col, where))

    def watch_query(self, col, where, cb):
        entry = (col, list(where), cb)
        self._watchers.append(entry)
        cb(self.query(col, where))
        return lambda: self._watchers.remove(entry)

    def watch_doc(self, col, id_, cb):
        entry = (col, id_, cb)
        self._doc_watchers.append(entry)
        cb(self.get(col, id_))
        return lambda: self._doc_watchers.remove(entry)


class FirestoreStore:
    """Firestore through firebase-admin. Listeners (watch_*) call back on a background thread."""

    def __init__(self, uid: str, service_account_path: str):
        import firebase_admin
        from firebase_admin import credentials, firestore
        from google.cloud.firestore_v1 import FieldFilter
        self._fs, self._FieldFilter = firestore, FieldFilter
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(service_account_path))
        self.client = firestore.client()
        self.root = self.client.collection("users").document(uid)
        self._lock = threading.Lock()

    def _ref(self, col, id_):
        return self.root.collection(col).document(id_)

    def _encode(self, data):
        return {k: self._fs.Increment(v.n) if isinstance(v, Increment) else v for k, v in data.items()}

    def _q(self, col, where=(), order_by=None, limit=None):
        q = self.root.collection(col)
        for f, op, v in where:
            q = q.where(filter=self._FieldFilter(f, op, v))
        if order_by:
            q = q.order_by(order_by[0], direction="DESCENDING" if order_by[1] == "desc" else "ASCENDING")
        if limit:
            q = q.limit(limit)
        return q

    def get(self, col, id_):
        s = self._ref(col, id_).get()
        return {"id": s.id, **s.to_dict()} if s.exists else None

    def set(self, col, id_, data):
        self._ref(col, id_).set(self._encode(data))

    def update(self, col, id_, patch):
        self._ref(col, id_).set(self._encode(patch), merge=True)

    def add(self, col, data) -> str:
        _, ref = self.root.collection(col).add(self._encode(data))
        return ref.id

    def delete(self, col, id_):
        self._ref(col, id_).delete()

    def query(self, col, where=(), order_by=None, limit=None):
        return [{"id": s.id, **s.to_dict()} for s in self._q(col, where, order_by, limit).stream()]

    def count(self, col, where=()):
        return int(self._q(col, where).count().get()[0][0].value)

    def watch_query(self, col, where, cb):
        w = self._q(col, where).on_snapshot(lambda snaps, _c, _t: cb([{"id": s.id, **s.to_dict()} for s in snaps]))
        return w.unsubscribe

    def watch_doc(self, col, id_, cb):
        def on(snaps, _c, _t):
            s = snaps[0] if snaps else None
            cb({"id": s.id, **s.to_dict()} if s is not None and s.exists else None)
        return self._ref(col, id_).on_snapshot(on).unsubscribe

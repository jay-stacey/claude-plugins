"""Server-sent events hub and the long-poll queues (mod inbox, voice jobs)."""
import json
import queue
import threading
import time
from collections import deque

RING = 500
CLIENT_QUEUE = 2000


class Hub:
    """Fan-out to SSE clients with an id counter and a ring for Last-Event-ID.

    Events published with keep=False (level, partial) get no id and are not
    kept in the ring: they are worthless once late.
    """

    def __init__(self, ring=RING):
        self.lock = threading.Lock()
        self.next_id = 1
        self.ring = deque(maxlen=ring)
        self.clients = set()
        self.last_client_at = time.time()

    def publish(self, event, data, keep=True):
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        with self.lock:
            eid = None
            if keep:
                eid = self.next_id
                self.next_id += 1
                self.ring.append((eid, event, payload))
            dead = []
            for q in self.clients:
                try:
                    q.put_nowait((eid, event, payload))
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self.clients.discard(q)
        return eid

    def subscribe(self, last_id=None):
        """(queue, replay). `replay` is the missed events when the ring still
        holds every one after `last_id`; None means send a snapshot instead."""
        q = queue.Queue(CLIENT_QUEUE)
        with self.lock:
            replay = None
            if last_id is not None and self.ring:
                first = self.ring[0][0]
                if last_id + 1 >= first and last_id < self.next_id:
                    replay = [e for e in self.ring if e[0] > last_id]
            self.clients.add(q)
            self.last_client_at = time.time()
        return q, replay

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)
            self.last_client_at = time.time()

    def client_count(self):
        with self.lock:
            return len(self.clients)


def frame(eid, event, payload) -> bytes:
    head = f"id: {eid}\n" if eid is not None else ""
    return f"{head}event: {event}\ndata: {payload}\n\n".encode("utf-8")


class Mailbox:
    """A queue a client long-polls: take() waits up to `wait` seconds."""

    def __init__(self, limit=200):
        self.cond = threading.Condition()
        self.items = []
        self.limit = limit

    def put(self, item):
        with self.cond:
            self.items.append(item)
            if len(self.items) > self.limit:
                self.items = self.items[-self.limit:]
            self.cond.notify_all()

    def take(self, wait):
        deadline = time.monotonic() + max(0.0, float(wait))
        with self.cond:
            while not self.items:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self.cond.wait(left)
            out, self.items = self.items, []
            return out

    def pending(self):
        with self.cond:
            return list(self.items)

    def drop(self, predicate):
        with self.cond:
            self.items = [i for i in self.items if not predicate(i)]

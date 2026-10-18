import http.client
import json
import threading
import time
import unittest

from helpers import Sandbox

from cos import paths
from cos.jev.engine import Jev
from cos.server import App, bind

TOKEN = "test-token-jev"
KEY = "sk-test-NOT-A-REAL-KEY-7f3a9c"


def events(q, name):
    out = []
    while not q.empty():
        e = q.get_nowait()
        if e[1] == name:
            out.append(json.loads(e[2]))
    return out


class SlowProvider:
    name = "hosted"

    def __init__(self, delay=0.0):
        self.delay = delay
        self.keys = []

    def decide(self, request, timeout_s):
        time.sleep(self.delay)
        return {"model": "opus", "route": "new_session", "background": True, "estimate_s": 1500}


class JevServer(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox().__enter__()
        self.app = App(TOKEN, 0, voice_enabled=False)
        self.server = bind(self.app, 0)
        self.port = self.app.port
        self.app.start_loops()
        self.assertTrue(self.app.ready.wait(10))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.thread.start()
        # A voice that is installed and ready, so acknowledgments are queued.
        self.app.voice.installed = True
        self.app.voice.status["state"] = "ready"

    def tearDown(self):
        self.app.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.box.__exit__(None, None, None)

    def call(self, method, path, body=None, token=TOKEN):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Host": f"127.0.0.1:{self.port}"}
        if token:
            headers["X-COS-Token"] = token
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        res = conn.getresponse()
        text = res.read().decode("utf-8")
        conn.close()
        return res.status, json.loads(text)

    def hello(self, **options):
        return self.call("POST", "/api/mod/hello", {"cliId": "cli-wait", "isChief": True, "options": options})

    def use_provider(self, provider, settings=None):
        """Jev with a fake hosted provider; the hello key reaches the factory."""
        seen = []

        def factory(cfg, key):
            seen.append(key)
            return provider
        self.app.jev = Jev(dict(self.app.settings, **(settings or {"jevProvider": "hosted", "jevModel": "test-model",
                                                                  "jevTimeoutMs": 2000})),
                           paths.home(), provider_factory=factory)
        return seen

    def inbox(self, wait=0):
        return self.call("GET", f"/api/mod/inbox?wait={wait}&cli=cli-wait")[1]["items"]

    def test_say_with_rules_acks_with_filler_and_queues_jev_and_hint(self):
        self.hello()
        q, _ = self.app.hub.subscribe()
        status, said = self.call("POST", "/api/chief/say", {"text": "What needs me?", "source": "voice"})
        self.assertEqual(status, 200)
        jobs = [j for j in self.app.voice_jobs.take(0) if j["kind"] == "ack"]
        self.assertEqual([j["filler"] for j in jobs], ["lookup"])
        items = self.inbox()
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual((item["id"], item["type"], item["text"]), (said["id"], "prompt", "What needs me?"))
        self.assertEqual((item["jev"]["route"], item["jev"]["filler"], item["jev"]["source"]), ("chief", "lookup", "rules"))
        self.assertTrue(item["hint"].startswith("Jev suggests: handle it yourself"))
        chat = self.call("GET", "/api/chat")[1]["messages"]
        self.assertEqual(chat[-1]["jev"], item["jev"])
        jev_events = events(q, "jev")
        self.assertEqual(jev_events, [{"id": said["id"], "decision": item["jev"]}])
        log = (paths.home() / "jev-log.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(log[-1])["id"], said["id"])

    def test_a_model_answer_comes_after_the_ack_and_prompts_keep_their_order(self):
        self.hello()
        self.use_provider(SlowProvider(delay=0.2))
        start = time.monotonic()
        first = self.call("POST", "/api/chief/say", {"text": "Fix the login bug", "source": "voice"})[1]
        second = self.call("POST", "/api/chief/say", {"text": "hello", "source": "voice"})[1]
        self.assertLess(time.monotonic() - start, 0.35)          # say returns at once
        acks = [j["filler"] for j in self.app.voice_jobs.take(0) if j["kind"] == "ack"]
        self.assertEqual(acks, ["work", "chat"])
        self.assertEqual(self.app.inbox.pending(), [])             # the model is still thinking
        items = []
        deadline = time.monotonic() + 5
        while len(items) < 2 and time.monotonic() < deadline:
            items += self.inbox(wait=1)
        self.assertEqual([i["id"] for i in items], [first["id"], second["id"]])
        self.assertEqual((items[0]["jev"]["source"], items[0]["jev"]["model"]), ("hosted", "opus"))
        self.assertIn("model opus", items[0]["hint"])
        self.assertEqual(self.app.jev.health()["fallbacks"], 0)

    def test_jev_outcome_writes_the_log(self):
        self.hello()
        said = self.call("POST", "/api/chief/say", {"text": "Fix the login bug"})[1]
        self.assertEqual(self.call("POST", "/api/mod/jev-outcome", {"id": said["id"], "route": "new_session",
                                                                    "model": "sonnet"}, token=None)[0], 401)
        self.assertEqual(self.call("POST", "/api/mod/jev-outcome", {"id": said["id"], "route": "nowhere"})[0], 400)
        self.assertEqual(self.call("POST", "/api/mod/jev-outcome", {"id": said["id"], "route": "chief",
                                                                    "model": "gpt"})[0], 400)
        status, body = self.call("POST", "/api/mod/jev-outcome", {"id": said["id"], "route": "new_session",
                                                                  "model": "sonnet"})
        self.assertEqual((status, body), (200, {"ok": True}))
        rows = [json.loads(x) for x in (paths.home() / "jev-log.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(rows[-1]["outcome"], {"route": "new_session", "model": "sonnet"})
        self.assertEqual(rows[-1]["id"], said["id"])
        # The model id the Chief passed to start_session is logged as its family.
        self.call("POST", "/api/mod/jev-outcome", {"id": said["id"], "route": "new_session", "model": "claude-opus-5-5"})
        rows = [json.loads(x) for x in (paths.home() / "jev-log.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(rows[-1]["outcome"], {"route": "new_session", "model": "opus"})

    def test_a_refused_hello_leaves_the_key_alone(self):
        self.hello(jev_api_key="sk-chief-key-0000000000000000")
        self.assertEqual(self.app.jev_key, "sk-chief-key-0000000000000000")
        # Another session's hello is refused, and a non-Chief hello steps nobody down here.
        status = self.call("POST", "/api/mod/hello", {"cliId": "cli-other", "isChief": True,
                                                      "options": {"jev_api_key": "sk-other-0000000000000000"}})[0]
        self.assertEqual(status, 409)
        self.call("POST", "/api/mod/hello", {"cliId": "cli-other", "isChief": False, "options": {}})
        self.assertEqual(self.app.jev_key, "sk-chief-key-0000000000000000")

    def test_a_worker_error_still_sends_the_prompt(self):
        self.use_provider(SlowProvider())
        self.hello()
        real = self.app.jev.record
        self.app.jev.record = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        self.addCleanup(setattr, self.app.jev, "record", real)
        broken = self.app.hub.publish
        self.app.hub.publish = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")) if a[0] == "jev" else broken(*a, **k)
        self.addCleanup(setattr, self.app.hub, "publish", broken)
        said = self.call("POST", "/api/chief/say", {"text": "Fix the login bug"})[1]
        deadline = time.time() + 5
        items = []
        while time.time() < deadline and not any(i.get("id") == said["id"] for i in items):
            items += self.inbox(wait=1)
        prompt = next(i for i in items if i.get("id") == said["id"])
        self.assertEqual(prompt["text"], "Fix the login bug")

    def test_the_api_key_stays_in_memory(self):
        seen = self.use_provider(SlowProvider())
        status, hello = self.hello(jev_provider="hosted", jev_model="test-model", jev_api_key=KEY)
        self.assertEqual(status, 200)
        self.assertEqual(self.app.jev_key, KEY)
        self.assertEqual(seen[-1], KEY)                            # the provider got it
        self.assertNotIn(KEY, json.dumps(hello))
        self.assertNotIn("jev_api_key", self.app.settings)
        self.assertNotIn(KEY, json.dumps(self.app.settings))
        self.call("POST", "/api/chief/say", {"text": "Fix the login bug"})
        deadline = time.monotonic() + 5
        while not self.inbox(wait=1) and time.monotonic() < deadline:
            pass
        status, health = self.call("GET", "/api/health", token=None)
        self.assertEqual(health["jev"], {"provider": "hosted", "model": "test-model", "fallbacks": 0})
        self.assertNotIn(KEY, json.dumps(health))
        self.assertNotIn(KEY, json.dumps(self.call("GET", "/api/chat")[1]))
        for p in paths.home().rglob("*"):
            if p.is_file():
                self.assertNotIn(KEY.encode(), p.read_bytes(), p.name)

    def test_health_reports_rules_by_default(self):
        health = self.call("GET", "/api/health", token=None)[1]
        self.assertEqual(health["jev"], {"provider": "rules", "model": None, "fallbacks": 0})


if __name__ == "__main__":
    unittest.main()

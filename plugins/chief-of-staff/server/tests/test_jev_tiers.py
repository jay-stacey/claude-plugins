"""Jev tier pick (cos/jev/tiers.py) against the baseline table. All hardware is made up."""
import copy
import unittest

import helpers  # noqa: F401  (puts server/ on sys.path)
from cos.jev import bench, tiers
from cos.jev.decision import Request

NVIDIA = {"vendor": "nvidia", "name": "Example RTX 4000", "integrated": False, "vramMb": 8192,
          "freeVramMb": 7000, "computeCap": "8.6", "driver": "560.10"}
IGPU = {"vendor": "intel", "name": "Example UHD Graphics", "integrated": True, "vramMb": 0,
        "freeVramMb": None, "computeCap": None, "driver": "31.0.101"}

BASE = {"os": "windows", "arch": "x64",
        "cpu": {"name": "Example 8-core CPU", "cores": 8, "threads": 16, "avx2": True, "avx512": False},
        "ramTotalMb": 16000, "ramFreeMb": 8000, "gpus": [IGPU], "npu": False, "diskFreeMb": 50000,
        "onBattery": False, "ollama": {"found": False, "path": None, "version": None, "listening": False,
                                       "loopbackOnly": None},
        "llamaServer": {"found": False, "path": None}}


def scan(**changes):
    s = copy.deepcopy(BASE)
    for key, value in changes.items():
        if key in s["cpu"] and key not in s:
            s["cpu"][key] = value
        else:
            s[key] = value
    return s


class TierTests(unittest.TestCase):
    def test_cpu_recommended(self):
        p = tiers.pick(scan())
        self.assertEqual((p["tier"], p["model"]), ("local-cpu", "qwen3.5-0.8b"))
        self.assertEqual(p["warnings"], [])
        self.assertTrue(p["reasons"])

    def test_gpu_tier(self):
        p = tiers.pick(scan(gpus=[IGPU, NVIDIA]))
        self.assertEqual((p["tier"], p["model"]), ("local-gpu", "qwen3.5-2b"))

    def test_gpu_needs_free_vram_after_voice(self):
        self.assertEqual(tiers.pick(scan(gpus=[NVIDIA]), voice_vram_mib=4200)["tier"], "local-gpu")
        p = tiers.pick(scan(gpus=[NVIDIA]), voice_vram_mib=5000)  # 2000 MiB left
        self.assertEqual(p["tier"], "local-cpu")
        self.assertTrue(any("video memory" in r for r in p["reasons"]))

    def test_gpu_boundaries(self):
        exact = dict(NVIDIA, freeVramMb=2048 + 4200)
        p = tiers.pick(scan(gpus=[exact]), voice_vram_mib=4200)
        self.assertEqual(p["tier"], "local-gpu")
        # 2048 MiB free: 2b needs 2048 > 60% of 2048, so it steps down to 0.8b on the GPU.
        self.assertEqual(p["model"], "qwen3.5-0.8b")
        self.assertTrue(any("60%" in w for w in p["warnings"]))
        self.assertEqual(tiers.pick(scan(gpus=[dict(NVIDIA, computeCap="5.0")]))["tier"], "local-gpu")
        self.assertEqual(tiers.pick(scan(gpus=[dict(NVIDIA, computeCap="3.7")]))["tier"], "local-cpu")
        self.assertEqual(tiers.pick(scan(gpus=[dict(NVIDIA, driver="550.00")]))["tier"], "local-gpu")
        p = tiers.pick(scan(gpus=[dict(NVIDIA, driver="546.33")]))
        self.assertEqual(p["tier"], "local-cpu")
        self.assertTrue(any("546.33" in r for r in p["reasons"]))

    def test_gpu_needs_16gb_and_disk(self):
        self.assertEqual(tiers.pick(scan(gpus=[NVIDIA], ramTotalMb=12000))["tier"], "local-cpu-min")
        self.assertEqual(tiers.pick(scan(gpus=[NVIDIA], diskFreeMb=4000))["tier"], "local-cpu-min")

    def test_integrated_gpu_is_no_gpu(self):
        fake_nvidia_igpu = dict(NVIDIA, integrated=True)
        self.assertEqual(tiers.pick(scan(gpus=[fake_nvidia_igpu]))["tier"], "local-cpu")
        self.assertEqual(tiers.pick(scan(gpus=[IGPU]))["tier"], "local-cpu")

    def test_cpu_boundaries(self):
        self.assertEqual(tiers.pick(scan(cores=6))["tier"], "local-cpu")
        self.assertEqual(tiers.pick(scan(cores=5))["tier"], "local-cpu-min")
        self.assertEqual(tiers.pick(scan(cores=4))["tier"], "local-cpu-min")
        p = tiers.pick(scan(cores=3))
        self.assertEqual(p["tier"], "hosted")
        self.assertIsNone(p["model"])
        self.assertTrue(any("3 cores" in r for r in p["reasons"]))

    def test_memory_boundaries(self):
        self.assertEqual(tiers.pick(scan(ramFreeMb=4096))["tier"], "local-cpu")
        self.assertEqual(tiers.pick(scan(ramFreeMb=4000))["tier"], "local-cpu-min")
        self.assertEqual(tiers.pick(scan(ramFreeMb=2560))["tier"], "local-cpu-min")
        self.assertEqual(tiers.pick(scan(ramFreeMb=2400))["tier"], "hosted")
        self.assertEqual(tiers.pick(scan(ramTotalMb=8000, ramFreeMb=3000))["tier"], "local-cpu-min")
        self.assertEqual(tiers.pick(scan(ramTotalMb=6000, ramFreeMb=3000))["tier"], "hosted")

    def test_disk_boundaries(self):
        self.assertEqual(tiers.pick(scan(diskFreeMb=5120))["tier"], "local-cpu")
        self.assertEqual(tiers.pick(scan(diskFreeMb=3072))["tier"], "local-cpu-min")
        p = tiers.pick(scan(diskFreeMb=2000))
        self.assertEqual(p["tier"], "hosted")
        self.assertTrue(any("disk" in r for r in p["reasons"]))

    def test_min_tier_warns(self):
        p = tiers.pick(scan(cores=4))
        self.assertEqual(p["model"], "qwen3.5-0.8b")
        self.assertTrue(any("minimum" in w for w in p["warnings"]))

    def test_no_avx2_or_arm(self):
        p = tiers.pick(scan(avx2=False))
        self.assertEqual(p["tier"], "hosted")
        self.assertTrue(any("AVX2" in r for r in p["reasons"]))
        p = tiers.pick(scan(arch="arm64", gpus=[NVIDIA]))
        self.assertEqual(p["tier"], "hosted")
        self.assertTrue(any("arm64" in r for r in p["reasons"]))

    def test_battery_drops_one_size(self):
        p = tiers.pick(scan(gpus=[NVIDIA], onBattery=True))
        self.assertEqual((p["tier"], p["model"]), ("local-gpu", "qwen3.5-0.8b"))
        self.assertTrue(any("battery" in w for w in p["warnings"]))
        p = tiers.pick(scan(onBattery=True))
        self.assertEqual(p["model"], "qwen3.5-0.8b")
        self.assertTrue(any("battery" in w for w in p["warnings"]))

    def test_fit_rule(self):
        self.assertFalse(tiers._fits("qwen3.5-2b", 3000))  # 2048 > 1800
        self.assertTrue(tiers._fits("qwen3.5-2b", 3414))
        self.assertTrue(tiers._fits("qwen3.5-0.8b", 2560))
        self.assertFalse(tiers._fits("qwen3.5-0.8b", 1600))
        p = tiers.pick(scan(gpus=[dict(NVIDIA, freeVramMb=3000)]))
        self.assertEqual((p["tier"], p["model"]), ("local-gpu", "qwen3.5-0.8b"))

    def test_missing_fields_give_hosted_with_reason(self):
        for field in ("arch", "ramTotalMb", "ramFreeMb", "diskFreeMb"):
            s = scan()
            s[field] = None
            p = tiers.pick(s)
            self.assertEqual(p["tier"], "hosted", field)
            self.assertTrue(p["reasons"], field)
        for field in ("avx2", "cores"):
            s = scan()
            s["cpu"][field] = None
            p = tiers.pick(s)
            self.assertEqual(p["tier"], "hosted", field)
            self.assertTrue(p["reasons"], field)
        self.assertEqual(tiers.pick({})["tier"], "hosted")
        self.assertEqual(tiers.pick(None)["tier"], "hosted")
        no_smi = dict(NVIDIA, freeVramMb=None, computeCap=None)
        self.assertEqual(tiers.pick(scan(gpus=[no_smi]))["tier"], "local-cpu")

    def test_reasons_are_sentences(self):
        for s in (scan(), scan(cores=2), scan(gpus=[NVIDIA]), scan(cores=4, onBattery=True)):
            p = tiers.pick(s)
            for line in p["reasons"] + p["warnings"]:
                self.assertTrue(line[0].isupper() and line.endswith("."), line)


class FakeProvider:
    def __init__(self, answers, step_ms):
        self.answers = list(answers)
        self.calls = 0
        self.step_ms = step_ms

    def decide(self, request, timeout_s):
        self.calls += 1
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


class BenchTests(unittest.TestCase):
    def test_samples(self):
        self.assertEqual(len(bench.SAMPLES), 10)
        self.assertTrue(all(isinstance(s, Request) and s.text for s in bench.SAMPLES))

    def test_percentile_nearest_rank(self):
        values = list(range(1, 11))
        self.assertEqual(bench.percentile(values, 50), 5)
        self.assertEqual(bench.percentile(values, 95), 10)
        self.assertEqual(bench.percentile([7], 95), 7)
        self.assertIsNone(bench.percentile([], 50))

    def test_run(self):
        good = {"model": "haiku", "route": "chief", "background": False, "estimate_s": 5}
        answers = [good, good, {"model": "gpt"}, RuntimeError("down")] + [good] * 7
        provider = FakeProvider(answers, 0)
        ticks = iter(range(0, 1000))
        clock = lambda: next(ticks) / 10  # every call takes 100 ms
        res = bench.run(provider, bench.SAMPLES, warmups=1, clock=clock)
        self.assertEqual(provider.calls, 11)
        self.assertEqual(res["total"], 10)
        self.assertEqual(res["valid"], 8)
        self.assertEqual((res["p50"], res["p95"]), (100, 100))


if __name__ == "__main__":
    unittest.main()

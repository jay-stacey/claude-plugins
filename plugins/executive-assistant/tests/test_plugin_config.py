import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import plugin_config  # noqa: E402


class OptionCase(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="ea-config-"))
        self.settings = self.dir / "settings.json"
        self.env = mock.patch.dict(os.environ, {"EA_SETTINGS_FILE": str(self.settings)})
        self.env.start()
        os.environ.pop("CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH", None)

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, configs):
        self.settings.write_text(json.dumps({"pluginConfigs": configs}), encoding="utf-8")

    def test_env_wins(self):
        self.write({"executive-assistant@personal-plugins": {"options": {"notes_vault_path": "C:/saved"}}})
        os.environ["CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH"] = "C:/env"
        self.assertEqual(plugin_config.option("notes_vault_path"), "C:/env")

    def test_settings_file_when_env_missing(self):
        self.write({"executive-assistant@personal-plugins": {"options": {"notes_vault_path": "C:/saved"}}})
        self.assertEqual(plugin_config.option("notes_vault_path"), "C:/saved")

    def test_personal_plugins_before_other_marketplaces(self):
        self.write({"executive-assistant@other": {"options": {"timezone": "UTC"}},
                    "executive-assistant@personal-plugins": {"options": {"timezone": "America/Toronto"}}})
        self.assertEqual(plugin_config.option("timezone"), "America/Toronto")

    def test_any_marketplace_as_fallback(self):
        self.write({"executive-assistant@other": {"options": {"timezone": "UTC"}}})
        self.assertEqual(plugin_config.option("timezone"), "UTC")

    def test_default_when_nothing_saved(self):
        self.assertEqual(plugin_config.option("timezone", "America/Toronto"), "America/Toronto")
        self.settings.write_text("not json", encoding="utf-8")
        self.assertIsNone(plugin_config.option("notes_vault_path"))


if __name__ == "__main__":
    unittest.main()

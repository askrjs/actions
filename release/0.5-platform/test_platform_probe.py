"""Tiny synthetic source controls only; no platform/bootstrap execution."""
import copy
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch
import platform_probe as p
import workflow_proposal as w


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.script = self.root / "platform_probe.py"
        self.script.write_text("synthetic source")
        self.package = p.encoded(p.PACKAGE)
        (self.root / "package.json").write_bytes(self.package)
        self.config = {"schemaVersion": 1, "stage": "lock-seed", "approvedForMeasurement": True,
            "source": {"repo": "askrjs/actions", "commit": "1" * 40, "baseCommit": p.H, "baseTree": p.H_TREE, "scriptSha256": p.sha(self.script.read_bytes())},
            "packageJson": {"file": "package.json", "sha256": p.sha(self.package)}}
        self.review = {"status": "APPROVED_PLATFORM_MEASUREMENT_SOURCE_ONLY", "stage": "lock-seed", "scriptSha256": self.config["source"]["scriptSha256"], "packageJsonSha256": p.sha(self.package)}
        self.write_review()

    def write_review(self):
        raw = p.encoded(self.review)
        (self.root / "review.json").write_bytes(raw)
        self.config["independentReview"] = {"file": "review.json", "sha256": p.sha(raw)}

    def validate(self):
        return p.validate_config(self.config, self.root, self.config["stage"], self.script)

    def lock(self):
        return {"lockfileVersion": 3, "packages": {"": {"dependencies": {"npm": "12.0.1"}}, "node_modules/npm": {"version": "12.0.1", "resolved": "https://registry.npmjs.org/npm/-/npm-12.0.1.tgz", "integrity": "sha512-" + base64.b64encode(b"a" * 64).decode()}}}

    def test_seed_source_accepts_and_rejects_missing_authority(self):
        self.assertEqual(self.validate(), self.package)
        for field, value in [("approvedForMeasurement", False), ("approvedForMeasurement", None), ("stage", "qualify")]:
            original = self.config[field]
            self.config[field] = value
            with self.assertRaises(ValueError): self.validate()
            self.config[field] = original
        for field, value in [("commit", None), ("commit", "main"), ("baseCommit", "2" * 40), ("scriptSha256", "f" * 64)]:
            original = self.config["source"][field]
            self.config["source"][field] = value
            with self.assertRaises(ValueError): self.validate()
            self.config["source"][field] = original

    def test_assets_review_and_no_application_dependency(self):
        for bad in [dict(p.PACKAGE, scripts={"postinstall": "node app.js"}), {"private": True, "dependencies": {"npm": "latest"}}, {"private": True, "dependencies": {"npm": "12.0.1", "@askrjs/auth": "0.5.0"}}]:
            raw = p.encoded(bad)
            (self.root / "package.json").write_bytes(raw)
            self.config["packageJson"]["sha256"] = p.sha(raw)
            with self.assertRaises(ValueError): self.validate()
        (self.root / "package.json").write_bytes(self.package)
        self.config["packageJson"]["sha256"] = p.sha(self.package)
        self.review["status"] = "PENDING"
        self.write_review()
        with self.assertRaises(ValueError): self.validate()

    def test_exact_stage_argv_no_bypass(self):
        self.assertEqual(p.tooling_argv("lock-seed", Path("/bootstrap/npm.js"), Path("/owned/npm")), [str(p.NODE), "/bootstrap/npm.js", "install", "--package-lock-only", "--prefix", "/owned/npm"])
        self.assertEqual(p.tooling_argv("measure", Path("/bootstrap/npm.js"), Path("/owned/npm")), [str(p.NODE), "/bootstrap/npm.js", "ci", "--prefix", "/owned/npm"])
        for bad in ["publish", "qualify", "seed", None]:
            with self.assertRaises(ValueError): p.tooling_argv(bad, Path("/npm"), self.root)

    def test_environment_drops_credentials_and_bypasses(self):
        with patch.dict(os.environ, {"NPM_TOKEN": "secret", "GITHUB_TOKEN": "secret", "GH_TOKEN": "secret", "NODE_OPTIONS": "--require evil", "NPM_CONFIG_IGNORE_SCRIPTS": "true", "NPM_CONFIG_LEGACY_PEER_DEPS": "true"}):
            env = p.clean_env(self.root)
        for key in ["NPM_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NODE_OPTIONS", "NPM_CONFIG_IGNORE_SCRIPTS", "NPM_CONFIG_LEGACY_PEER_DEPS"]:
            self.assertNotIn(key, env)
        self.assertEqual(env["HOME"], str(self.root / "home"))
        self.assertEqual(env["NPM_CONFIG_REGISTRY"], "https://registry.npmjs.org/")
        self.assertEqual(env["npm_config_@askrjs:registry"], "https://registry.npmjs.org/")

    def test_lock_rejects_wrong_cohort_and_extra_owner(self):
        p.validate_lock(p.encoded(self.lock()))
        for edit in [lambda x: x["packages"]["node_modules/npm"].update(version="12.0.2"), lambda x: x["packages"]["node_modules/npm"].update(resolved="https://foreign.test/npm.tgz"), lambda x: x["packages"].update({"node_modules/evil": {"version": "1"}}), lambda x: x["packages"][""].update(dependencies={"npm": "^12.0.1"}), lambda x: x["packages"]["node_modules/npm"].pop("integrity")]:
            lock = self.lock()
            edit(lock)
            with self.assertRaises(ValueError): p.validate_lock(p.encoded(lock))

    def test_measure_requires_exact_seed_lock_tools_review(self):
        lock = p.encoded(self.lock())
        (self.root / "package-lock.json").write_bytes(lock)
        tools = {name: {"file": "/actual/" + name, "sha256": "a" * 64, "fullVersion": "actual full version\n"} for name in ["python", "git", "gh", "node", "bootstrapNpmCli"]}
        tools.update({name: {"root": "/actual/" + name, "projectionSha256": "b" * 64} for name in ["nodeRuntime", "bootstrapNpmRuntime"]})
        platform = {"ImageOS": "ubuntu24", "ImageVersion": "synthetic-owned-control"}
        seed = p.encoded({"status": "SUCCESS_MEASUREMENT_ONLY", "stage": "lock-seed", "lockSha256": p.sha(lock), "packageJsonSha256": p.sha(self.package), "tools": tools, "platformIdentity": platform})
        (self.root / "seed-receipt.json").write_bytes(seed)
        self.config.update(stage="measure", lock={"file": "package-lock.json", "sha256": p.sha(lock)}, seedReceipt={"file": "seed-receipt.json", "sha256": p.sha(seed)}, expectedTools=tools, expectedPlatform=platform)
        self.review.update(stage="measure", lockSha256=p.sha(lock), seedReceiptSha256=p.sha(seed), expectedToolsSha256=p.sha(p.encoded(tools)), expectedPlatformSha256=p.sha(p.encoded(platform)))
        self.write_review()
        self.validate()
        for edit in [lambda: self.config.update(expectedTools=None), lambda: self.config.update(expectedPlatform=None), lambda: self.config["lock"].update(sha256="f" * 64), lambda: self.config["seedReceipt"].update(sha256="e" * 64)]:
            original = copy.deepcopy(self.config)
            edit()
            with self.assertRaises(ValueError): self.validate()
            self.config = original

    def test_file_ownership_projection_and_no_external_links(self):
        runtime = self.root / "runtime"
        runtime.mkdir()
        (runtime / "bin").mkdir()
        (runtime / "bin/tool").write_text("tool")
        (runtime / "alias").symlink_to("bin/tool")
        self.assertEqual(len(p.projection(runtime)), 2)
        (runtime / "escape").symlink_to("../../outside")
        with self.assertRaises(ValueError): p.projection(runtime)
        with self.assertRaises(ValueError): p.file_bytes(runtime / "alias")

    def test_disk_failure_prevents_command_and_is_recorded(self):
        evidence = self.root / "evidence"
        evidence.mkdir()
        with patch.object(p.shutil, "disk_usage", return_value=types.SimpleNamespace(free=p.MIN_FREE - 1)), patch.object(p.subprocess, "run") as spawn:
            with self.assertRaises(ValueError): p.guard_disk(self.root, evidence, "before-normal-ci")
            spawn.assert_not_called()
        self.assertEqual(json.loads((evidence / "headroom.jsonl").read_text())["minFreeBytes"], 8589934592)

    def test_literal_command_preserves_logs_timeout_and_no_shell(self):
        evidence = self.root / "evidence"
        evidence.mkdir()
        with patch.object(p.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as spawn:
            p.command(["/literal/tool", "--version"], {"HOME": "/owned"}, self.root, evidence, "version")
            self.assertFalse(spawn.call_args.kwargs["shell"])
            self.assertEqual(spawn.call_args.kwargs["timeout"], 300)
        with patch.object(p.subprocess, "run", side_effect=subprocess.TimeoutExpired("literal", 300)):
            with self.assertRaises(subprocess.TimeoutExpired): p.command(["/literal/tool"], {}, self.root, evidence, "timeout")
        self.assertIsNone(json.loads((evidence / "timeout.command.json").read_text())["exit"])

    def test_run_rejects_wrong_platform_before_subprocess_or_owned_writes(self):
        args = types.SimpleNamespace(stage="lock-seed", config="/absent/config.json", config_sha256="a" * 64, bundle="/absent")
        with patch.object(p.sys, "platform", "darwin"), patch.object(p.subprocess, "run") as spawn, patch.object(p.Path, "mkdir") as mkdir:
            with self.assertRaisesRegex(ValueError, "Linux x86_64"):
                p.run(args)
            spawn.assert_not_called()
            mkdir.assert_not_called()

    def test_unapproved_templates_are_not_execution_authority(self):
        for stage in ["lock-seed", "measure"]:
            config = json.loads(Path(__file__).with_name(stage + "-config.TEMPLATE.json").read_text())
            self.assertFalse(config["approvedForMeasurement"])
            self.assertIsNone(config["source"]["commit"])
            self.assertIsNone(config["independentReview"]["sha256"])
            with self.assertRaisesRegex(ValueError, "reviewed measurement authority"):
                p.validate_config(config, self.root, stage, self.script)

    def test_assets_reject_traversal_symlink_and_wrong_digest(self):
        for name in ["../package.json", "/package.json", "nested/package.json", "Package.json"]:
            with self.assertRaises(ValueError):
                p.asset(self.root, {"file": name, "sha256": p.sha(self.package)})
        with self.assertRaises(ValueError):
            p.asset(self.root, {"file": "package.json", "sha256": "f" * 64})
        (self.root / "link.json").symlink_to("package.json")
        with self.assertRaises(ValueError):
            p.asset(self.root, {"file": "link.json", "sha256": p.sha(self.package)})
        (self.root / "linked-parent").symlink_to(self.root)
        with self.assertRaises(ValueError):
            p.file_bytes(self.root / "linked-parent/package.json")

    def test_workflow_only_ordinary_pr_and_pinned_readonly_actions(self):
        text = w.render("1" * 40, "2" * 40, "3" * 64, "lock-seed")
        for marker in ["pull_request:", "ubuntu-24.04", "contents: read", "actions: read", "node-version: 24.21.0", "persist-credentials: false", "retention-days: 90", "if: always()", "Bounded source controls only", "python3 -B -m unittest discover", w.CHECKOUT, w.SETUP_NODE, w.UPLOAD]: self.assertIn(marker, text)
        for marker in ["workflow_dispatch", "id-token", "write", "GITHUB_TOKEN", "npm publish", "publish-package", "qualify-g2", "candidate-graph"]: self.assertNotIn(marker, text)
        for args in [(None, "2" * 40, "3" * 64, "lock-seed"), ("main", "2" * 40, "3" * 64, "measure"), ("1" * 40, "2" * 40, None, "measure"), ("1" * 40, "2" * 40, "3" * 64, "qualify")]:
            with self.assertRaises(ValueError): w.render(*args)


if __name__ == "__main__":
    unittest.main()

"""Nonpublishing Linux tool measurements; never runs a release graph phase."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys

H = "f1d2022fafa05d09ad259c442c15758b5d5fff57"
H_TREE = "3c400f12d3d8cf30a4d4e76ca80fc593823d6005"
PARENT = Path("/home/runner/work/_temp")
ANCHOR = PARENT / "askr-050-platform-probe"
NODE = Path("/opt/hostedtoolcache/node/24.21.0/x64/bin/node")
MIN_FREE = 8 * 1024**3
PACKAGE = {"private": True, "dependencies": {"npm": "12.0.1"}}
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")


def need(value, message):
    if not value:
        raise ValueError(message)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def exact_keys(value, names, label):
    need(isinstance(value, dict) and set(value) == set(names), label)


def ancestors(path):
    path = Path(path)
    need(path.is_absolute() and ".." not in path.parts, "absolute literal path required")
    for parent in reversed(path.parents):
        need(not parent.is_symlink() and parent.is_dir(), "nonlink directory ancestors required")
    return path


def file_bytes(path):
    path = ancestors(path)
    need(not path.is_symlink() and path.is_file(), "regular nonlink input required")
    return path.read_bytes()


def file_hash(path):
    path = ancestors(path)
    need(not path.is_symlink() and path.is_file(), "regular binary required")
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def asset(bundle, record):
    exact_keys(record, ["file", "sha256"], "asset record")
    name = record["file"]
    need(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9-]*\.json", name), "literal asset filename")
    need(isinstance(record["sha256"], str) and HEX64.fullmatch(record["sha256"]), "asset digest")
    data = file_bytes(bundle / name)
    need(sha(data) == record["sha256"], "asset digest mismatch")
    return data


def validate_config(config, bundle, stage, script):
    need(stage in ["lock-seed", "measure"], "one literal measurement stage required")
    fields = ["schemaVersion", "stage", "approvedForMeasurement", "source", "packageJson", "independentReview"]
    if stage == "measure":
        fields += ["lock", "seedReceipt", "expectedTools", "expectedPlatform"]
    exact_keys(config, fields, "exact stage config")
    need(config["schemaVersion"] == 1 and config["stage"] == stage and config["approvedForMeasurement"] is True,
         "reviewed measurement authority required")
    source = config["source"]
    exact_keys(source, ["repo", "commit", "baseCommit", "baseTree", "scriptSha256"], "source authority")
    need(source["repo"] == "askrjs/actions" and source["baseCommit"] == H and source["baseTree"] == H_TREE,
         "accepted Actions H source basis")
    need(isinstance(source["commit"], str) and HEX40.fullmatch(source["commit"]), "immutable probe source commit")
    need(source["scriptSha256"] == sha(file_bytes(script)), "probe source bytes differ")
    package = asset(bundle, config["packageJson"])
    need(json.loads(package) == PACKAGE, "literal npm-only tooling manifest")
    review = json.loads(asset(bundle, config["independentReview"]))
    need(isinstance(review, dict) and review.get("status") == "APPROVED_PLATFORM_MEASUREMENT_SOURCE_ONLY" and
         review.get("stage") == stage and review.get("scriptSha256") == source["scriptSha256"] and
         review.get("packageJsonSha256") == sha(package), "independent source review binding")
    if stage == "measure":
        lock = asset(bundle, config["lock"])
        validate_lock(lock)
        seed = asset(bundle, config["seedReceipt"])
        receipt = json.loads(seed)
        need(receipt.get("status") == "SUCCESS_MEASUREMENT_ONLY" and receipt.get("stage") == "lock-seed" and
             receipt.get("lockSha256") == sha(lock) and receipt.get("packageJsonSha256") == sha(package),
             "actual successful lock-seed receipt binding")
        need(config["expectedTools"] == receipt.get("tools"), "exact reviewed seed tool identities")
        need(isinstance(config["expectedPlatform"], dict) and config["expectedPlatform"] and
             config["expectedPlatform"] == receipt.get("platformIdentity"), "actual seed platform identity")
        tools = config["expectedTools"]
        exact_keys(tools, ["python", "git", "gh", "node", "bootstrapNpmCli", "nodeRuntime", "bootstrapNpmRuntime"], "complete actual seed tool authority")
        for name in ["python", "git", "gh", "node", "bootstrapNpmCli"]:
            exact_keys(tools[name], ["file", "sha256", "fullVersion"], "actual binary identity")
            need(isinstance(tools[name]["file"], str) and Path(tools[name]["file"]).is_absolute() and
                 isinstance(tools[name]["sha256"], str) and HEX64.fullmatch(tools[name]["sha256"]) and
                 isinstance(tools[name]["fullVersion"], str) and tools[name]["fullVersion"], "no absent actual tool identity")
        for name in ["nodeRuntime", "bootstrapNpmRuntime"]:
            exact_keys(tools[name], ["root", "projectionSha256"], "actual runtime identity")
            need(isinstance(tools[name]["root"], str) and Path(tools[name]["root"]).is_absolute() and
                 isinstance(tools[name]["projectionSha256"], str) and HEX64.fullmatch(tools[name]["projectionSha256"]), "no absent actual runtime projection")
        need(review.get("lockSha256") == sha(lock) and review.get("seedReceiptSha256") == sha(seed) and
             review.get("expectedToolsSha256") == sha(encoded(config["expectedTools"])) and
             review.get("expectedPlatformSha256") == sha(encoded(config["expectedPlatform"])),
             "independent lock/tool measurement review binding")
    return package


def validate_lock(raw):
    lock = json.loads(raw)
    need(isinstance(lock, dict) and lock.get("lockfileVersion") == 3, "canonical npm lock v3")
    packages = lock.get("packages")
    need(isinstance(packages, dict) and "" in packages and "node_modules/npm" in packages, "npm root lock entries")
    need(packages[""].get("dependencies") == {"npm": "12.0.1"}, "exact sole direct npm dependency")
    need(all(name in ["", "node_modules/npm"] or name.startswith("node_modules/npm/node_modules/")
             for name in packages), "no non-npm tooling dependencies")
    npm = packages["node_modules/npm"]
    need(npm.get("version") == "12.0.1" and npm.get("resolved") == "https://registry.npmjs.org/npm/-/npm-12.0.1.tgz" and
         isinstance(npm.get("integrity"), str) and re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", npm["integrity"]),
         "canonical npm12 archive identity")
    need(len(base64.b64decode(npm["integrity"][7:], validate=True)) == 64, "full SHA512 archive SRI")
    return lock


def clean_env(anchor, node=NODE):
    return {
        "HOME": str(anchor / "home"), "PATH": str(node.parent) + ":/usr/bin:/bin",
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC",
        "TMPDIR": str(anchor / "tmp"), "GH_CONFIG_DIR": str(anchor / "gh-config"),
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0",
        "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
        "npm_config_@askrjs:registry": "https://registry.npmjs.org/",
        "NPM_CONFIG_USERCONFIG": str(anchor / "user.npmrc"),
        "NPM_CONFIG_GLOBALCONFIG": str(anchor / "global.npmrc"),
        "NPM_CONFIG_CACHE": str(anchor / "npm-cache"),
        "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false",
        "NPM_CONFIG_FETCH_RETRIES": "0", "NPM_CONFIG_FETCH_TIMEOUT": "120000",
    }


def projection(runtime):
    runtime = ancestors(runtime)
    need(runtime.is_dir() and not runtime.is_symlink(), "regular runtime root")
    result = []
    for path in sorted(runtime.rglob("*")):
        name = path.relative_to(runtime).as_posix()
        if path.is_symlink():
            link = os.readlink(path)
            need(not Path(link).is_absolute() and runtime.resolve() in path.resolve().parents,
                 "external or escaping runtime link")
            result.append({"path": name, "mode": "120000", "sha256": sha(link.encode())})
        elif path.is_file():
            result.append({"path": name, "mode": oct(stat.S_IMODE(path.stat().st_mode)), "sha256": file_hash(path)})
        else:
            need(path.is_dir(), "nonregular runtime entry")
    return result


def command(argv, env, cwd, evidence, label):
    need(isinstance(argv, list) and all(isinstance(arg, str) for arg in argv), "literal argv required")
    code = None
    try:
        with (evidence / (label + ".stdout.log")).open("xb") as stdout, (evidence / (label + ".stderr.log")).open("xb") as stderr:
            result = subprocess.run(argv, cwd=cwd, env=env, shell=False, timeout=300, stdout=stdout, stderr=stderr)
        code = result.returncode
        need(code == 0, label + " failed; raw evidence retained")
    finally:
        (evidence / (label + ".command.json")).write_bytes(encoded({"argv": argv, "cwd": str(cwd), "exit": code, "timeoutSeconds": 300}))
    return (evidence / (label + ".stdout.log")).read_text()


def guard_disk(anchor, evidence, label):
    free = shutil.disk_usage(anchor).free
    with (evidence / "headroom.jsonl").open("ab") as stream:
        stream.write(encoded({"stage": label, "freeBytes": free, "minFreeBytes": MIN_FREE}))
    need(free >= MIN_FREE, "8 GiB headroom floor; no command launched")


def tooling_argv(stage, npm_cli, target, node=NODE):
    need(stage in ["lock-seed", "measure"], "one literal tooling stage")
    return ([str(node), str(npm_cli), "install", "--package-lock-only", "--prefix", str(target)]
            if stage == "lock-seed" else [str(node), str(npm_cli), "ci", "--prefix", str(target)])


def run(args):
    need(sys.platform == "linux" and platform.machine() == "x86_64" and sys.version_info[:2] == (3, 12),
         "Linux x86_64 / Python3.12 required")
    need(os.environ.get("RUNNER_OS") == "Linux" and os.environ.get("RUNNER_ARCH") == "X64" and
         os.environ.get("ImageOS") == "ubuntu24" and os.environ.get("ImageVersion"), "Ubuntu24.04 hosted image receipt")
    need(Path(os.environ.get("RUNNER_TEMP", "")) == PARENT, "literal runner temp root")
    script = Path(__file__).resolve()
    bundle = ancestors(Path(args.bundle).absolute())
    need(bundle.is_dir() and not bundle.is_symlink(), "nonlink asset bundle")
    raw_config = file_bytes(Path(args.config).absolute())
    need(isinstance(args.config_sha256, str) and HEX64.fullmatch(args.config_sha256) and
         sha(raw_config) == args.config_sha256, "exact reviewed config digest")
    config = json.loads(raw_config)
    package = validate_config(config, bundle, args.stage, script)
    ancestors(PARENT / "unused")
    need(PARENT.stat().st_uid == os.getuid() and not ANCHOR.exists() and not ANCHOR.is_symlink(),
         "entire owned fixed probe anchor must be absent")
    ANCHOR.mkdir(mode=0o700)
    evidence = ANCHOR / "evidence"
    evidence.mkdir()
    receipt = {"status": "FAILED_PRESERVED", "stage": args.stage, "configSha256": sha(raw_config),
               "source": config["source"], "packageJsonSha256": sha(package),
               "releaseQualification": False, "finalToolAuthorityApproved": False}
    try:
        (evidence / "measurement-config.json").write_bytes(raw_config)
        (evidence / "independent-review.json").write_bytes(asset(bundle, config["independentReview"]))
        guard_disk(ANCHOR, evidence, "owned-bootstrap")
        for name in ["home", "tmp", "gh-config", "npm-cache", "npm-tooling"]:
            (ANCHOR / name).mkdir()
        for name in ["user.npmrc", "global.npmrc"]:
            (ANCHOR / name).write_bytes(b"")
        env = clean_env(ANCHOR)
        (evidence / "private-config.json").write_bytes(encoded(env))
        image = {name: os.environ.get(name) for name in ["ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"]}
        image.update({"platform": platform.platform(), "pythonFullVersion": sys.version, "osRelease": file_bytes(Path("/etc/os-release")).decode()})
        os_release = dict(line.split("=", 1) for line in image["osRelease"].splitlines() if "=" in line and not line.startswith("#"))
        need(os_release.get("ID", "").strip('"') == "ubuntu" and os_release.get("VERSION_ID", "").strip('"') == "24.04", "actual Ubuntu24.04 release")
        (evidence / "image.json").write_bytes(encoded(image))
        receipt["platformIdentity"] = {name: value for name, value in image.items() if name not in ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"]}
        tools = {}
        for name, binary, argv in [
            ("python", Path(sys.executable).resolve(), ["--version"]),
            ("git", Path(shutil.which("git") or "").resolve(), ["--version", "--build-options"]),
            ("gh", Path(shutil.which("gh") or "").resolve(), ["--version"]),
            ("node", NODE.resolve(), ["--version"]),
        ]:
            output = command([str(binary), *argv], env, ANCHOR, evidence, name + "-version")
            tools[name] = {"file": str(binary), "sha256": file_hash(binary), "fullVersion": output}
        need(tools["node"]["fullVersion"].strip() == "v24.21.0", "exact Node24.21.0")
        source_root = script.parents[2]
        source_commit = command([tools["git"]["file"], "-C", str(source_root), "rev-parse", "HEAD"], env, ANCHOR, evidence, "probe-source-head").strip()
        need(source_commit == config["source"]["commit"], "checked-out immutable probe source differs")
        node_root = NODE.parent.parent.resolve()
        npm_root = node_root / "lib/node_modules/npm"
        npm_cli = npm_root / "bin/npm-cli.js"
        tools["bootstrapNpmCli"] = {"file": str(npm_cli), "sha256": file_hash(npm_cli), "fullVersion": command([str(NODE), str(npm_cli), "--version"], env, ANCHOR, evidence, "bootstrap-npm-version")}
        for name, root in [("nodeRuntime", node_root), ("bootstrapNpmRuntime", npm_root)]:
            raw = encoded(projection(root))
            (evidence / (name + "-projection.json")).write_bytes(raw)
            tools[name] = {"root": str(root), "projectionSha256": sha(raw)}
        receipt["tools"] = tools
        if args.stage == "measure":
            need(tools == config["expectedTools"], "measured seed tool identity drift; new independent review required")
            need(receipt["platformIdentity"] == config["expectedPlatform"], "measured seed image/platform drift; new independent review required")
        target = ANCHOR / "npm-tooling"
        (target / "package.json").write_bytes(package)
        (evidence / "package.json").write_bytes(package)
        if args.stage == "measure":
            (target / "package-lock.json").write_bytes(asset(bundle, config["lock"]))
        command([str(NODE), str(npm_cli), "config", "list", "--json"], env, target, evidence, "bootstrap-npm-config")
        guard_disk(ANCHOR, evidence, "normal-tooling-" + args.stage)
        command(tooling_argv(args.stage, npm_cli, target), env, ANCHOR, evidence, "normal-tooling-" + args.stage)
        need(file_bytes(target / "package.json") == package, "tooling manifest changed")
        lock = file_bytes(target / "package-lock.json")
        (evidence / "package-lock.json").write_bytes(lock)
        validate_lock(lock)
        if args.stage == "lock-seed":
            need(not (target / "node_modules").exists(), "lock-only seed must not materialize installed dependencies")
        else:
            need(lock == asset(bundle, config["lock"]), "normal ci changed reviewed lock")
            installed_root = target / "node_modules/npm"
            installed_manifest = json.loads(file_bytes(installed_root / "package.json"))
            need(installed_manifest["name"] == "npm" and installed_manifest["version"] == "12.0.1", "installed npm12 identity")
            raw = encoded(projection(installed_root))
            (evidence / "installed-npm-runtime-projection.json").write_bytes(raw)
            receipt["installedRuntimeProjectionSha256"] = sha(raw)
            for name in ["npm", "npx"]:
                cli = installed_root / ("bin/" + name + "-cli.js")
                version = command([str(NODE), str(cli), "--version"], env, ANCHOR, evidence, "installed-" + name + "-version")
                need(version.strip() == "12.0.1", "installed exact npm/npx12 version")
                receipt[name + "Cli"] = {"file": str(cli), "sha256": file_hash(cli), "fullVersion": version}
            command([str(NODE), str(installed_root / "bin/npm-cli.js"), "config", "list", "--json"], env, target, evidence, "installed-npm-config")
        (evidence / "package-lock.json").write_bytes(lock)
        receipt["lockSha256"] = sha(lock)
        guard_disk(ANCHOR, evidence, "completed-measurement")
        receipt["status"] = "SUCCESS_MEASUREMENT_ONLY"
    finally:
        generated_lock = ANCHOR / "npm-tooling/package-lock.json"
        if generated_lock.exists() and not generated_lock.is_symlink() and generated_lock.is_file() and not (evidence / "package-lock.json").exists():
            (evidence / "package-lock.json").write_bytes(file_bytes(generated_lock))
        (evidence / "receipt.json").write_bytes(encoded(receipt))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["lock-seed", "measure"], required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--bundle", required=True)
    run(parser.parse_args())

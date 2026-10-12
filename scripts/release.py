"""Build reproducible source releases; recover a tag instead of bumping on retry."""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSET = "agent-message-board.zip"
DIST = ROOT / "dist"
SEMVER = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def run(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def version_key(tag: str) -> tuple[int, ...]:
    return tuple(int(part) for part in tag[1:].split("."))


def build(bump: str) -> None:
    if bump not in {"patch", "minor", "major"}:
        raise ValueError("Choose patch, minor, or major")
    run("git", "fetch", "origin", "--tags")
    tags = sorted(filter(SEMVER.fullmatch, run("git", "tag").splitlines()), key=version_key)
    head = run("git", "rev-parse", "HEAD")
    existing = [tag for tag in tags if run("git", "rev-parse", f"{tag}^{{commit}}") == head]
    if existing:
        tag = existing[-1]
    elif not tags:
        tag = "v0.1.0"
    else:
        parts = list(version_key(tags[-1]))
        index = {"major": 0, "minor": 1, "patch": 2}[bump]
        parts[index] += 1
        parts[index + 1 :] = [0] * (2 - index)
        tag = "v" + ".".join(map(str, parts))
    version = tag[1:]
    DIST.mkdir(exist_ok=True)
    files = run("git", "ls-files", "-z").split("\0")
    files = [name for name in files if name]
    required = {
        "models.py",
        "storage.py",
        "server.py",
        "help_content.py",
        "schema.sql",
        "pyproject.toml",
        "uv.lock",
        ".python-version",
        "viewer_routes.py",
        "viewer/index.html",
    }
    assert required <= set(files), f"Missing runtime files: {required - set(files)}"
    with zipfile.ZipFile(DIST / ASSET, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            data = (ROOT / name).read_bytes()
            if name == "pyproject.toml":
                text, count = re.subn(
                    r'(\[project\]\s*\nname = "agent-message-board"\s*\nversion = ")[^"]+',
                    rf"\g<1>{version}",
                    data.decode(),
                    count=1,
                )
                assert count == 1, "Project version metadata missing"
                data = text.encode()
            elif name == "uv.lock":
                text, count = re.subn(
                    r'(\[\[package\]\]\s*\nname = "agent-message-board"\s*\nversion = ")[^"]+',
                    rf"\g<1>{version}",
                    data.decode(),
                    count=1,
                )
                assert count == 1, "Lock version metadata missing"
                data = text.encode()
            entry = zipfile.ZipInfo(f"agent-message-board/{name}", (2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100000 | ((ROOT / name).stat().st_mode & 0o777)) << 16
            archive.writestr(entry, data)
    with zipfile.ZipFile(DIST / ASSET) as archive:
        for name in ["pyproject.toml", "uv.lock"]:
            metadata = tomllib.loads(archive.read(f"agent-message-board/{name}").decode())
            actual = (
                metadata["project"]["version"]
                if name.endswith("toml")
                else next(
                    item["version"]
                    for item in metadata["package"]
                    if item["name"] == "agent-message-board"
                )
            )
            assert actual == version, f"{name}: {actual} != {version}"
        assert archive.testzip() is None
    digest = hashlib.sha256((DIST / ASSET).read_bytes()).hexdigest()
    (DIST / "release-plan.json").write_text(
        json.dumps({"tag": tag, "head": head, "sha256": digest})
    )
    print(f"Prepared {tag}: {ASSET} ({digest})")


def publish() -> None:
    plan = json.loads((DIST / "release-plan.json").read_text())
    tag = plan["tag"]
    repo = os.environ["GITHUB_REPOSITORY"]
    remote = run(
        "git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"
    )
    if remote:
        remote_refs = dict(line.split()[::-1] for line in remote.splitlines())
        target = remote_refs.get(f"refs/tags/{tag}^{{}}", remote_refs[f"refs/tags/{tag}"])
        assert target == plan["head"], "Remote tag moved"
    else:
        local_tags = run("git", "tag", "--list", tag)
        if local_tags:
            assert run("git", "rev-parse", f"{tag}^{{commit}}") == plan["head"], "Local tag moved"
        else:
            run("git", "tag", tag, plan["head"])
        run("git", "push", "origin", f"refs/tags/{tag}")
    releases = json.loads(run("gh", "api", "--paginate", "--slurp", f"repos/{repo}/releases"))
    release = next((r for page in releases for r in page if r["tag_name"] == tag), None)
    if release is None:
        run(
            "gh",
            "release",
            "create",
            tag,
            "--repo",
            repo,
            "--draft",
            "--title",
            tag,
            "--generate-notes",
            "--verify-tag",
        )
        release = {"draft": True, "assets": []}
    if not release["draft"]:
        assert any(a["name"] == ASSET for a in release["assets"]), "Published release incomplete"
    else:
        run("gh", "release", "upload", tag, str(DIST / ASSET), "--repo", repo, "--clobber")
    with tempfile.TemporaryDirectory() as directory:
        run(
            "gh", "release", "download", tag, "--repo", repo, "--pattern", ASSET, "--dir", directory
        )
        actual = hashlib.sha256((Path(directory) / ASSET).read_bytes()).hexdigest()
        assert actual == plan["sha256"], "Remote asset checksum mismatch"
    if release["draft"]:
        run("gh", "release", "edit", tag, "--repo", repo, "--draft=false", "--latest")
    print(f"Verified published {tag}: {ASSET}")


if __name__ == "__main__":
    if sys.argv[1] == "build":
        build(sys.argv[2])
    elif sys.argv[1] == "publish":
        publish()
    else:
        raise SystemExit("Usage: release.py build patch|minor|major / publish")

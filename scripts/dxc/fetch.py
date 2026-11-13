#!/usr/bin/env python3
"""Fetch Microsoft's DXC shader compiler so the Windows game starts fast on DirectX 12.

    python scripts/dxc/fetch.py

Without it, wgpu compiles shaders for DirectX 12 with the old FXC compiler, and the island
takes 20-60 s to appear while the terrain shader compiles. With dxcompiler.dll and dxil.dll
next to the game, it uses DXC, which is much faster. Bevy's own
`statically-linked-dxc` feature would do this at build time, but it only exists for the
MSVC toolchain and this project also builds with the GNU one.

Downloads the pinned release from github.com/microsoft/DirectXShaderCompiler (University of
Illinois/NCSA and MIT licences, redistributable; the licence files are kept beside the DLLs)
into vendor/dxc/, then copies the DLLs next to the built game in target/<profile>/ for every
profile that exists (run it again after `cargo clean` or a first build). The game says on start
which compiler it uses.
"""
import io, json, os, shutil, sys, urllib.request, zipfile

TAG = "v1.8.2505"
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
VENDOR = os.path.join(ROOT, "vendor", "dxc")
DLLS = ("dxcompiler.dll", "dxil.dll")
UA = {"User-Agent": "discover-earth-dxc/1", "Accept": "application/vnd.github+json"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return r.read()


def release_zip():
    rel = json.loads(get(f"https://api.github.com/repos/microsoft/DirectXShaderCompiler/releases/tags/{TAG}"))
    # The Windows build is the plain dxc_<date>.zip; the others are named for Linux or clang.
    for asset in rel.get("assets", []):
        name = asset["name"]
        if name.startswith("dxc_") and name.endswith(".zip") and "linux" not in name.lower():
            return name, asset["browser_download_url"]
    raise SystemExit(f"DXC release {TAG} has no Windows zip; pick another TAG in {__file__}")


def unpack(data):
    os.makedirs(VENDOR, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()
        for dll in DLLS:
            src = next((n for n in names if n.replace("\\", "/").lower() == f"bin/x64/{dll}"), None)
            if src is None:
                raise SystemExit(f"bin/x64/{dll} missing from the DXC zip")
            with open(os.path.join(VENDOR, dll), "wb") as f:
                f.write(z.read(src))
        for n in names:
            if os.path.basename(n).upper().startswith("LICENSE"):
                with open(os.path.join(VENDOR, os.path.basename(n)), "wb") as f:
                    f.write(z.read(n))
    with open(os.path.join(VENDOR, "VERSION"), "w") as f:
        f.write(TAG + "\n")


def main():
    have = os.path.join(VENDOR, "VERSION")
    if not (os.path.exists(have) and open(have).read().strip() == TAG
            and all(os.path.exists(os.path.join(VENDOR, d)) for d in DLLS)):
        name, url = release_zip()
        print(f"downloading {name} ({TAG})")
        unpack(get(url))
    copied = []
    target = os.path.join(ROOT, "target")
    for profile in ("debug", "release"):
        d = os.path.join(target, profile)
        if os.path.isdir(d):
            for dll in DLLS:
                shutil.copy2(os.path.join(VENDOR, dll), os.path.join(d, dll))
            copied.append(d)
    print(f"DXC {TAG} in {VENDOR}")
    print("copied next to: " + (", ".join(copied) if copied else "nothing yet (build the game, then run this again)"))


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Download the scanned ground materials listed in content/materials.json from ambientCG (CC0).

    python3 scripts/materials/fetch.py            # all layers
    python3 scripts/materials/fetch.py rock       # one layer

Writes content/materials/<layer>/albedo.jpg and normal.jpg (OpenGL normals), all at the
same size, which the terrain shader picks up on the next run; without them it draws the
layers from noise. Pick other sets by changing the ids in content/materials.json (browse
https://ambientcg.com/list?type=Material) and run this again. Needs network access to
ambientcg.com and acg-download.struffelproductions.com.
"""
import io, json, os, sys, urllib.request, zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../..")
CONTENT = os.path.join(ROOT, "content")
SIZE = 1024
UA = {"User-Agent": "discover-earth-materials/1"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return r.read()


def zip_url(asset, resolution):
    info = json.loads(get(f"https://ambientcg.com/api/v2/full_json?id={asset}&include=downloadData"))
    found = info.get("foundAssets") or []
    if not found:
        raise SystemExit(f"ambientCG has no asset `{asset}`: fix content/materials.json")
    cats = found[0]["downloadFolders"]["default"]["downloadFiletypeCategories"]["zip"]["downloads"]
    for d in cats:
        if d["attribute"] == resolution:
            return d["downloadLink"]
    raise SystemExit(f"`{asset}` has no {resolution} download (have: {', '.join(d['attribute'] for d in cats)})")


def main():
    from PIL import Image

    cfg = json.load(open(os.path.join(CONTENT, "materials.json")))
    want = sys.argv[1:] or list(cfg["layers"])
    for layer in want:
        asset = cfg["layers"][layer]
        z = zipfile.ZipFile(io.BytesIO(get(zip_url(asset, cfg["resolution"]))))
        names = z.namelist()
        pick = lambda key: next((n for n in names if n.endswith(f"_{key}.jpg")), None)
        colour, normal = pick("Color"), pick("NormalGL")
        if not colour or not normal:
            raise SystemExit(f"`{asset}` zip lacks Color or NormalGL jpg: {names}")
        out = os.path.join(CONTENT, "materials", layer)
        os.makedirs(out, exist_ok=True)
        for src, dst in [(colour, "albedo.jpg"), (normal, "normal.jpg")]:
            img = Image.open(io.BytesIO(z.read(src))).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
            img.save(os.path.join(out, dst), quality=90)
        print(f"{layer}: {asset} -> {out}")


if __name__ == "__main__":
    main()

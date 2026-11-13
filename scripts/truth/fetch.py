#!/usr/bin/env python3
"""Ground truth for an island from open satellite data, on the island's own heightmap grid.

    pip install rasterio pyproj
    python3 scripts/truth/fetch.py saksun [--tile 29VNK] [--scenes 12]

Writes next to terrain.json:
  satellite.png   cloud-free ground colour: per-pixel median of the clearest Sentinel-2 L2A
                  summer scenes (surface reflectance of B04/B03/B02, sRGB-encoded so 255 = 100%)
  landcover.png   ESA WorldCover 2021 class per pixel (8-bit class codes: 10 tree, 20 shrub,
                  30 grass, 40 crop, 50 built, 60 bare, 70 snow, 80 water, 90 wetland, 95 mangrove,
                  100 moss and lichen)
  truth.json      where they came from, their licences, and the scenes used

Both grids are 2x the heightmap's (half a DEM pixel each), north-up, covering the same area.
Data: Copernicus Sentinel-2 (free and open, attribution "Contains modified Copernicus Sentinel
data <year>") via the sentinel-cogs bucket on AWS; ESA WorldCover 10 m 2021 v200, CC BY 4.0.
"""
import argparse, json, os, re, sys, urllib.request, warnings
from xml.etree import ElementTree

import numpy as np
import rasterio
import rasterio.errors
from rasterio.warp import Resampling, reproject
from rasterio.transform import from_origin

# PNG outputs carry no georeference on purpose (the grid is defined by terrain.json).
warnings.filterwarnings("ignore", category=rasterio.errors.NotGeoreferencedWarning)
warnings.filterwarnings("ignore", message="All-NaN slice")

S2 = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
WC = "https://esa-worldcover.s3.eu-central-1.amazonaws.com"
# SCL classes that show the ground: vegetation, bare soil, water, snow.
CLEAR = [4, 5, 6, 11]


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def list_prefixes(prefix):
    xml = get(f"{S2}/?list-type=2&delimiter=/&prefix={prefix}").decode()
    return re.findall(r"<Prefix>([^<]+/)</Prefix>", xml)[1:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("island")
    ap.add_argument("--tile", default="29VNK", help="Sentinel-2 MGRS tile covering the island")
    ap.add_argument("--scenes", type=int, default=12, help="clear scenes to take the median of")
    ap.add_argument("--years", default="2019-2025")
    args = ap.parse_args()

    root = os.path.join(os.path.dirname(__file__), "../../content/islands", args.island)
    t = json.load(open(os.path.join(root, "terrain.json")))
    w, h = t["size_px"]
    lat0, lon0 = t["origin"]["north_lat"], t["origin"]["west_lon"]
    # GLO-30 pixels at this latitude: 1 arc-second north-south, 2 east-west (see import.py).
    dlat, dlon = 1 / 3600, 2 / 3600
    W, H = w * 2, h * 2
    dst_tf = from_origin(lon0, lat0, dlon / 2, dlat / 2)
    bbox = (lon0, lat0 - h * dlat, lon0 + w * dlon, lat0)
    print(f"{args.island}: {W}x{H} px over lon {bbox[0]:.4f}..{bbox[2]:.4f}, lat {bbox[1]:.4f}..{bbox[3]:.4f}")

    def warp(src, band, resampling, dtype):
        out = np.zeros((H, W), dtype=dtype)
        reproject(rasterio.band(src, band), out, dst_transform=dst_tf, dst_crs="EPSG:4326", resampling=resampling)
        return out

    # 1. Candidate scenes: summer (May to September), sorted by the tile's cloud cover.
    zone, band, sq = args.tile[:2], args.tile[2], args.tile[3:]
    y0, y1 = map(int, args.years.split("-"))
    cands = []
    for year in range(y0, y1 + 1):
        for month in range(5, 10):
            for p in list_prefixes(f"sentinel-s2-l2a-cogs/{zone}/{band}/{sq}/{year}/{month}/"):
                sid = p.rstrip("/").split("/")[-1]
                try:
                    item = json.loads(get(f"{S2}/{p}{sid}.json"))
                except Exception:
                    continue
                cc = item["properties"].get("eo:cloud_cover", 100)
                if cc < 60:
                    cands.append((cc, p, sid, item))
    cands.sort(key=lambda c: c[0])
    print(f"{len(cands)} summer scenes under 60% cloud on {args.tile}")

    # 2. Clear fraction over the island itself (the tile is ~110 km; clouds are local).
    stack, used = [], []
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", AWS_NO_SIGN_REQUEST="YES"):
        for cc, p, sid, item in cands:
            if len(used) >= args.scenes:
                break
            scl = warp(rasterio.open(f"{S2}/{p}SCL.tif"), 1, Resampling.nearest, np.uint8)
            clear = np.isin(scl, CLEAR)
            frac = clear.mean()
            print(f"  {sid}: tile cloud {cc:.0f}%, island clear {frac * 100:.0f}%")
            if frac < 0.5:
                continue
            off = 0 if item["properties"].get("earthsearch:boa_offset_applied", True) else 1000
            rgb = []
            for b in ("B04", "B03", "B02"):
                v = warp(rasterio.open(f"{S2}/{p}{b}.tif"), 1, Resampling.average, np.float32)
                rgb.append((v - off) / 10000.0)
            rgb = np.stack(rgb, -1)
            rgb[~clear] = np.nan
            stack.append(rgb)
            used.append({"id": sid, "date": item["properties"]["datetime"][:10], "island_clear": round(float(frac), 3)})
    if not stack:
        sys.exit("no clear scenes found; widen --years or raise the cloud limit")
    med = np.nanmedian(np.stack(stack), axis=0)
    missing = np.isnan(med).any(-1)
    med[missing] = 0
    print(f"median of {len(stack)} scenes; {missing.mean() * 100:.1f}% of pixels never clear")

    def srgb(x):
        x = np.clip(x, 0, 1)
        return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)

    img = (srgb(med) * 255 + 0.5).astype(np.uint8)
    with rasterio.open(os.path.join(root, "satellite.png"), "w", driver="PNG", width=W, height=H, count=3,
                       dtype="uint8") as d:
        for i in range(3):
            d.write(img[..., i], i + 1)

    # 3. Land cover: ESA WorldCover 3x3 degree tile containing the island.
    la = int(np.floor(bbox[1] / 3) * 3)
    lo = int(np.floor(bbox[0] / 3) * 3)
    name = f"ESA_WorldCover_10m_2021_v200_{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}_Map.tif"
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        lc = warp(rasterio.open(f"{WC}/v200/2021/map/{name}"), 1, Resampling.mode, np.uint8)
    with rasterio.open(os.path.join(root, "landcover.png"), "w", driver="PNG", width=W, height=H, count=1,
                       dtype="uint8") as d:
        d.write(lc, 1)
    classes, counts = np.unique(lc, return_counts=True)
    print("land cover:", {int(c): round(float(n) / lc.size, 3) for c, n in zip(classes, counts)})

    years = sorted({u["date"][:4] for u in used})
    json.dump({
        "grid": {"size_px": [W, H], "per_heightmap_px": 2, "north_lat": lat0, "west_lon": lon0},
        "satellite": {
            "file": "satellite.png",
            "what": "per-pixel median surface reflectance (B04, B03, B02) of clear Sentinel-2 L2A summer scenes, sRGB-encoded",
            "tile": args.tile,
            "scenes": used,
            "never_clear": round(float(missing.mean()), 4),
            "attribution": f"Contains modified Copernicus Sentinel data {years[0]}-{years[-1]}",
        },
        "landcover": {
            "file": "landcover.png",
            "what": "ESA WorldCover 10 m 2021 v200 class codes",
            "source": name,
            "attribution": "ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
            "licence": "CC BY 4.0",
        },
    }, open(os.path.join(root, "truth.json"), "w"), indent=2)
    print("wrote satellite.png, landcover.png, truth.json")


if __name__ == "__main__":
    main()

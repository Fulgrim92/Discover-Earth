#!/usr/bin/env python3
"""Cut an island's heightfield out of a Copernicus GLO-30 DEM tile.

    pip install tifffile imagecodecs numpy
    python3 scripts/terrain/fetch.py N62 W008            # downloads the tile into out/dem/
    python3 scripts/terrain/import.py out/dem/Copernicus_DSM_COG_10_N62_00_W008_00_DEM.tif \
        --id saksun --name "Saksun and Tjornuvik, Streymoy" --lat 62.262 --lon -7.163 --size 512

Writes content/islands/<id>/height.png (16-bit greyscale, row 0 = north) and fills the
generated fields of content/islands/<id>/terrain.json (size, spacing, height range, origin,
source). Hand-written fields in an existing terrain.json (spawn, shots, look) are kept.
Then run `de validate`.

Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
provided under COPERNICUS by the European Union and ESA; free to use with this attribution.
"""
import argparse, json, math, os, re, struct, zlib

import numpy as np
import tifffile


def write_png16(path, a):
    """16-bit greyscale PNG with nothing but numpy and zlib."""
    h, w = a.shape
    raw = b"".join(b"\x00" + a[r].astype(">u2").tobytes() for r in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, 0, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("tile")
    p.add_argument("--id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--lat", type=float, required=True, help="centre latitude")
    p.add_argument("--lon", type=float, required=True, help="centre longitude")
    p.add_argument("--size", type=int, default=512, help="pixels per side")
    p.add_argument("--content", default=os.path.join(os.path.dirname(__file__), "../../content"))
    a = p.parse_args()

    m = re.search(r"([NS])(\d+)_00_([EW])(\d+)_00", os.path.basename(a.tile))
    if not m:
        raise SystemExit("tile name must look like Copernicus_DSM_COG_10_N62_00_W008_00_DEM.tif")
    lat0 = int(m[2]) * (1 if m[1] == "N" else -1)  # south edge
    lon0 = int(m[4]) * (1 if m[3] == "E" else -1)  # west edge
    dem = tifffile.imread(a.tile).astype(np.float32)
    rows, cols = dem.shape
    dlat, dlon = 1.0 / rows, 1.0 / cols  # degrees per pixel
    r = int(round((lat0 + 1 - a.lat) / dlat)) - a.size // 2
    c = int(round((a.lon - lon0) / dlon)) - a.size // 2
    r = max(0, min(rows - a.size, r))
    c = max(0, min(cols - a.size, c))
    crop = dem[r:r + a.size, c:c + a.size]
    crop = np.where(np.isfinite(crop), crop, 0.0)
    lo, hi = float(math.floor(crop.min())), float(math.ceil(crop.max()))
    q = np.round((crop - lo) / max(hi - lo, 1e-6) * 65535).astype(np.uint16)

    out = os.path.join(a.content, "islands", a.id)
    os.makedirs(out, exist_ok=True)
    write_png16(os.path.join(out, "height.png"), q)

    north = lat0 + 1 - r * dlat
    west = lon0 + c * dlon
    mid_lat = math.radians(north - a.size * dlat / 2)
    metres_lat = 111_320.0 * dlat
    metres_lon = 111_320.0 * math.cos(mid_lat) * dlon
    path = os.path.join(out, "terrain.json")
    doc = json.load(open(path)) if os.path.exists(path) else {}
    doc.update({
        "name": a.name,
        "heightmap": "height.png",
        "size_px": [a.size, a.size],
        "metres_per_px": [round(metres_lon, 3), round(metres_lat, 3)],
        "height_range_m": [lo, hi],
        "origin": {"north_lat": round(north, 6), "west_lon": round(west, 6)},
        "source": {
            "dataset": "Copernicus DEM GLO-30",
            "tile": os.path.basename(a.tile),
            "attribution": "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
        },
    })
    with open(path, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"{out}: {a.size}x{a.size} px, {lo:.0f}..{hi:.0f} m, {metres_lon:.1f} x {metres_lat:.1f} m/px")


if __name__ == "__main__":
    main()

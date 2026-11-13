#!/usr/bin/env python3
"""Download one Copernicus GLO-30 DEM tile (1x1 degree, open data on AWS) into out/dem/.

    python3 scripts/terrain/fetch.py N62 W008
"""
import os, sys, urllib.request

lat, lon = sys.argv[1].upper(), sys.argv[2].upper()
name = f"Copernicus_DSM_COG_10_{lat}_00_{lon}_00_DEM"
url = f"https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif"
out = os.path.join(os.path.dirname(__file__), "../../out/dem")
os.makedirs(out, exist_ok=True)
dest = os.path.join(out, name + ".tif")
if not os.path.exists(dest):
    urllib.request.urlretrieve(url, dest)
print(dest)

#!/usr/bin/env python3
"""Fetch the reference photos of an island from Wikimedia Commons, with their licence and author.

    python3 scripts/truth/photos.py saksun [--width 1280] [--force]

Reads content/references/<island>/references.json; for every photo it looks up the Commons file
(`commons`), refuses anything that is not CC0, public domain or CC BY / CC BY-SA, saves a copy
`--width` pixels wide as `<id>.jpg`, and writes `source` (page, author, licence, date, GPS tag,
focal length, credit line) back into references.json. Hand-written fields (`guess`,
`ignore_columns`, `camera`) are kept. It also writes `light` from the photo's EXIF: when it was
taken (UTC, from local Faroese time) and the camera's exposure (EV100 from shutter, aperture and
ISO), so `de photo match --photo-light` can light each render as the place was. `--meta` refreshes
only that, without downloading images again. Needs Pillow. Commons rate-limits often; the script waits
and retries, and skips photos it already has unless --force.
"""

import argparse
import datetime
import html
import math
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "discover-earth-truth/0.1 (open-source game; reference photo fetcher)"
API = "https://commons.wikimedia.org/w/api.php"
# Thumbnail widths Commons serves (https://w.wiki/GHai).
WIDTHS = [330, 500, 960, 1280, 1920]
FREE = re.compile(r"^(CC0|Public domain|CC BY(-SA)? [0-9.]+)", re.I)


def get(url):
    for attempt in range(10):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503):
                raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(min(5 * 2**attempt, 90))
    raise SystemExit(f"gave up on {url} (Commons keeps refusing; try again later)")


def plain(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def info(title):
    q = urllib.parse.urlencode({
        "action": "query", "format": "json", "titles": title, "prop": "imageinfo|coordinates",
        "iiprop": "url|size|extmetadata|metadata", "coprimary": "all", "coprop": "type",
    })
    page = next(iter(json.loads(get(f"{API}?{q}"))["query"]["pages"].values()))
    if "imageinfo" not in page:
        raise SystemExit(f"{title}: not on Commons (check the `commons` title)")
    return page


def focal_35mm(meta):
    exif = {m["name"]: m["value"] for m in meta or [] if isinstance(m.get("value"), (str, int, float))}
    f = exif.get("FocalLengthIn35mmFilm")
    try:
        return float(f) if f else None
    except ValueError:
        return None


def last_sunday(year, month):
    d = datetime.date(year, month + 1, 1) - datetime.timedelta(days=1) if month < 12 else datetime.date(year, 12, 31)
    return d - datetime.timedelta(days=(d.weekday() + 1) % 7)


def to_utc(local):
    """Faroese local time (WET, WEST in summer: EU rules) to UTC."""
    start = datetime.datetime.combine(last_sunday(local.year, 3), datetime.time(1))
    end = datetime.datetime.combine(last_sunday(local.year, 10), datetime.time(1))
    summer = start <= local < end
    return local - datetime.timedelta(hours=1 if summer else 0)


def ratio(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and "/" in v:
        a, b = v.split("/", 1)
        return float(a) / float(b) if float(b) else None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def light(meta, ext_date):
    """`light` for references.json from EXIF (`meta`) and Commons' date text, or None."""
    exif = {m["name"]: m["value"] for m in meta or [] if isinstance(m.get("value"), (str, int, float))}
    local, known = None, False
    raw = exif.get("DateTimeOriginal")
    if raw:
        try:
            local, known = datetime.datetime.strptime(raw.strip(), "%Y:%m:%d %H:%M:%S"), True
        except ValueError:
            pass
    if local is None:
        m = re.search(r"(\d{1,2}) (\w+) (\d{4})", ext_date or "") or None
        if m:
            try:
                day = datetime.datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%d %B %Y")
                # Time unknown: assume early afternoon, when most tourist photos are taken.
                local = day.replace(hour=14)
            except ValueError:
                pass
        m = None if local else re.search(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?", ext_date or "")
        if m:
            local = datetime.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4) or 14), int(m.group(5) or 0))
            known = m.group(4) is not None
    if local is None:
        return None
    t, n = ratio(exif.get("ExposureTime")), ratio(exif.get("FNumber"))
    iso = ratio(exif.get("ISOSpeedRatings") or exif.get("PhotographicSensitivity"))
    bias = ratio(exif.get("ExposureBiasValue")) or 0.0
    ev = None
    if t and n and iso:
        # EV100 of the exposure used; a positive bias means the camera exposed brighter than its
        # meter, which is already in t, n and iso.
        ev = round(math.log2(n * n / t) - math.log2(iso / 100.0), 2)
    out = {"taken_utc": to_utc(local).strftime("%Y-%m-%dT%H:%M:%SZ"), "time_known": known}
    if ev is not None:
        out["exposure_ev100"] = ev
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("island")
    ap.add_argument("--width", type=int, default=1280, choices=WIDTHS)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--meta", action="store_true", help="only refresh `light` from EXIF")
    a = ap.parse_args()
    from PIL import Image

    root = os.path.join(os.path.dirname(__file__), "../../content/references", a.island)
    path = os.path.join(root, "references.json")
    doc = json.load(open(path, encoding="utf-8"))
    for p in doc["photos"]:
        jpg = os.path.join(root, f"{p['id']}.jpg")
        if a.meta:
            page = info(p["commons"])
            ii = page["imageinfo"][0]
            ext = plain(ii.get("extmetadata", {}).get("DateTimeOriginal", {}).get("value"))
            lt = light(ii.get("metadata"), ext)
            if lt:
                p["light"] = lt
            print(f"{p['id']}: light {lt}")
            time.sleep(1.0)
            continue
        if os.path.exists(jpg) and p.get("source") and not a.force:
            print(f"{p['id']}: have it")
            continue
        page = info(p["commons"])
        ii = page["imageinfo"][0]
        m = {k: v.get("value", "") for k, v in ii.get("extmetadata", {}).items()}
        licence = plain(m.get("LicenseShortName"))
        if not FREE.match(licence) or "NC" in licence or "ND" in licence:
            raise SystemExit(f"{p['id']}: licence `{licence}` is not free enough; pick another photo")
        author = plain(m.get("Artist")) or "unknown"
        cams = [c for c in page.get("coordinates", []) if c.get("type") == "camera"]
        url = ii["url"].split("?")[0]
        width = min(a.width, ii["width"])
        if width < ii["width"]:
            name = url.rsplit("/", 1)[1]
            src = url.replace("/commons/", "/commons/thumb/", 1) + f"/{width}px-{name}"
            if name.lower().endswith((".tif", ".tiff")):
                src += ".jpg"
        else:
            src = url
        img = Image.open(io.BytesIO(get(src)))
        img = img.convert("RGB")
        if img.width > a.width:
            img = img.resize((a.width, round(img.height * a.width / img.width)), Image.LANCZOS)
        img.save(jpg, quality=88, optimize=True)
        page_url = ii.get("descriptionurl") or f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(p['commons'])}"
        source = {
            "page": page_url,
            "author": author,
            "licence": licence,
            "licence_url": m.get("LicenseUrl", ""),
            "date": re.sub(r"\s*\(.*$", "", plain(m.get("DateTimeOriginal")))[:60],
            "gps": [cams[0]["lat"], cams[0]["lon"]] if cams else None,
            "focal_35mm": focal_35mm(ii.get("metadata")),
            "original_size": [ii["width"], ii["height"]],
            "credit": f"{p['commons'].removeprefix('File:')} by {author}, {licence}, via Wikimedia Commons",
        }
        # Keep key order: id, commons, source, then the hand-written fields.
        rest = {k: v for k, v in p.items() if k not in ("id", "commons", "source", "light")}
        lt = light(ii.get("metadata"), plain(m.get("DateTimeOriginal")))
        new = {"id": p["id"], "commons": page["title"], "source": source, **({"light": lt} if lt else {}), **rest}
        p.clear()
        p.update(new)
        print(f"{p['id']}: {img.width}x{img.height}, {licence}, {author}")
        time.sleep(1.0)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()

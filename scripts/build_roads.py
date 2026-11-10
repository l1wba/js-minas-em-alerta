#!/usr/bin/env python3
"""Build a light GeoJSON with the federal highways (BRs) that appear in the PRF snapshot.

The geometry comes from OpenStreetMap (ODbL) through the Overpass API. Ways are
merged into continuous lines and simplified so the file stays small enough to
ship with the static site.

Usage:
    python scripts/build_roads.py                      # downloads from Overpass
    python scripts/build_roads.py --osm ways.json      # reuses a saved Overpass response
"""

import argparse
import json
import re
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HIGHWAYS = "motorway|trunk|primary|secondary|tertiary"
TOLERANCE = 0.0012  # degrees (~130 m), Douglas-Peucker
PRECISION = 4


def roads_from_prf(path):
    snapshot = json.loads(Path(path).read_text(encoding="utf-8"))
    roads = {incident["road"] for incident in snapshot["incidents"]}
    return sorted(road for road in roads if re.fullmatch(r"BR-\d{3}", road) and road != "BR-000")


def fetch_overpass(roads):
    numbers = "|".join(road[3:] for road in roads)
    query = f"""
[out:json][timeout:300];
area["ISO3166-2"="BR-MG"]->.mg;
way(area.mg)["highway"~"^({HIGHWAYS})$"]["ref"~"BR-({numbers})"];
out geom qt;
"""
    data = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(OVERPASS_URL, data=data, headers={"User-Agent": "road-map-builder/1.0"})
    with urllib.request.urlopen(request, timeout=400) as response:
        return json.loads(response.read().decode("utf-8"))


def merge_lines(lines):
    """Greedily join polylines that share endpoints."""
    lines = [list(line) for line in lines if len(line) > 1]
    key = lambda point: (round(point[0], 6), round(point[1], 6))
    merged = True
    while merged:
        merged = False
        ends = defaultdict(list)
        for index, line in enumerate(lines):
            ends[key(line[0])].append(index)
            ends[key(line[-1])].append(index)
        used = set()
        result = []
        for index, line in enumerate(lines):
            if index in used:
                continue
            used.add(index)
            current = line
            extended = True
            while extended:
                extended = False
                for at_end in (True, False):
                    point = key(current[-1] if at_end else current[0])
                    for other in ends[point]:
                        if other in used:
                            continue
                        candidate = lines[other]
                        if at_end:
                            if key(candidate[0]) == point:
                                current = current + candidate[1:]
                            elif key(candidate[-1]) == point:
                                current = current + candidate[::-1][1:]
                            else:
                                continue
                        else:
                            if key(candidate[-1]) == point:
                                current = candidate[:-1] + current
                            elif key(candidate[0]) == point:
                                current = candidate[::-1][:-1] + current
                            else:
                                continue
                        used.add(other)
                        extended = merged = True
                        break
            result.append(current)
        lines = result
    return lines


def simplify(points, tolerance):
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        ax, ay = points[start]
        bx, by = points[end]
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        best, best_index = 0.0, -1
        for index in range(start + 1, end):
            px, py = points[index]
            if length == 0:
                distance = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
                distance = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if distance > best:
                best, best_index = distance, index
        if best > tolerance * tolerance:
            keep[best_index] = True
            stack.append((start, best_index))
            stack.append((best_index, end))
    return [point for point, flag in zip(points, keep) if flag]


def build(osm, roads):
    by_road = defaultdict(list)
    wanted = {road[3:] for road in roads}
    for element in osm.get("elements", []):
        geometry = element.get("geometry")
        if element.get("type") != "way" or not geometry:
            continue
        line = [(node["lon"], node["lat"]) for node in geometry]
        for number in set(re.findall(r"BR-(\d{3})", element.get("tags", {}).get("ref", ""))):
            if number in wanted:
                by_road[f"BR-{number}"].append(line)

    features = []
    for road in roads:
        lines = merge_lines(by_road.get(road, []))
        coordinates = []
        for line in lines:
            simple = simplify(line, TOLERANCE)
            if len(simple) < 2:
                continue
            coordinates.append([[round(x, PRECISION), round(y, PRECISION)] for x, y in simple])
        if coordinates:
            features.append({
                "type": "Feature",
                "properties": {"road": road},
                "geometry": {"type": "MultiLineString", "coordinates": coordinates},
            })
    return {
        "type": "FeatureCollection",
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "features": features,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prf", default="data/prf-2026.json", help="PRF snapshot used to list the BRs")
    parser.add_argument("--osm", help="Saved Overpass JSON response (skips the download)")
    parser.add_argument("--output", default="data/minas-gerais-brs.geojson")
    args = parser.parse_args()

    roads = roads_from_prf(args.prf)
    osm = json.loads(Path(args.osm).read_text(encoding="utf-8")) if args.osm else fetch_overpass(roads)
    collection = build(osm, roads)
    output = Path(args.output)
    output.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    points = sum(len(line) for feature in collection["features"] for line in feature["geometry"]["coordinates"])
    print(f"{len(collection['features'])} BRs · {points:,} points · {output.stat().st_size / 1024:.0f} KB -> {output}")


if __name__ == "__main__":
    main()

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
import heapq
import json
import math
import os
import re
import time
import urllib.parse
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# Ways that are not part of the main carriageway (ramps, service roads, paths) are left out.
EXCLUDED_HIGHWAYS = re.compile(r"_link$|^(service|track|path|footway|cycleway|steps|pedestrian|platform|proposed|abandoned|razed|bus_stop|rest_area|services)$")
REF_PATTERN = re.compile(r"BR\s*-?\s*(\d{2,3})", re.IGNORECASE)
TOLERANCE = 0.0012  # degrees (~130 m), Douglas-Peucker
PRECISION = 4


def accident_points(data_dir):
    """PRF accident coordinates per BR, used to confirm shared stretches."""
    points = defaultdict(list)
    for path in Path(data_dir).glob("prf-*.json"):
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        for incident in snapshot["incidents"]:
            points[incident["road"]].append((incident["longitude"], incident["latitude"]))
    return points


def roads_from_prf(data_dir):
    roads = set()
    for path in Path(data_dir).glob("prf-*.json"):
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        roads |= {incident["road"] for incident in snapshot["incidents"]}
    return sorted(road for road in roads if re.fullmatch(r"BR-\d{3}", road) and road != "BR-000")


def fetch_overpass(roads):
    """Ways tagged with the BR ref (any spelling, any highway type including roads under
    construction) plus every way that belongs to the BR's route relation, which covers
    stretches whose ways carry no ref of their own."""
    numbers = "|".join(road[3:] for road in roads)
    ref = f"BR *-? *0?({numbers})([^0-9]|$)"
    query = f"""
[out:json][timeout:600];
area["ISO3166-2"="BR-MG"]->.mg;
rel(area.mg)["route"="road"]["ref"~"{ref}"]->.rels;
way(r.rels)(area.mg)["highway"]->.relways;
way(area.mg)["highway"]["ref"~"{ref}"]->.refways;
.rels out body;
(.relways; .refways;);
out geom qt;
"""
    data = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(4):
        try:
            request = urllib.request.Request(OVERPASS_URL, data=data, headers={"User-Agent": "road-map-builder/1.0"})
            with urllib.request.urlopen(request, timeout=700) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # Overpass answers 429/502/504 when busy; wait and try again.
            if error.code not in (429, 502, 503, 504) or attempt == 3:
                raise
            print(f"Overpass ocupado (HTTP {error.code}); nova tentativa em {30 * (attempt + 1)} s…")
            time.sleep(30 * (attempt + 1))


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


COS_LAT = math.cos(math.radians(20))
SNAP_KM = 0.6          # how close a loose end must be to the other BR's line
MAX_BRIDGE_KM = 80     # longest shared stretch that will be borrowed


def distance_km(a, b):
    return math.hypot((a[0] - b[0]) * 111.32 * COS_LAT, (a[1] - b[1]) * 110.57)


MIN_FRAGMENT_KM = 2.0  # shorter pieces are stray tags, not stretches worth connecting


def line_length(line):
    return sum(distance_km(line[i - 1], line[i]) for i in range(1, len(line)))


def loose_ends(lines):
    """Endpoints that do not touch any other line of the same road (short fragments ignored)."""
    ends = []
    for index, line in enumerate(lines):
        if line_length(line) < MIN_FRAGMENT_KM:
            continue
        for point in (line[0], line[-1]):
            touching = any(
                distance_km(point, other[0]) < SNAP_KM or distance_km(point, other[-1]) < SNAP_KM
                or any(distance_km(point, vertex) < SNAP_KM for vertex in other[::5])
                for other_index, other in enumerate(lines) if other_index != index
            )
            if not touching:
                ends.append((index, point))
    return ends


def bridge_shared_stretches(merged, evidence):
    """Close gaps where a BR shares the carriageway of another BR.

    OSM often tags a shared stretch with only one of the refs, so the other BR shows a gap.
    For each pair of loose ends of a BR, the shortest path between them over the whole
    BR network is borrowed, but only when it is not a long detour and the PRF recorded
    accidents with this BR number along it (evidence that the BR really runs there)."""
    graph = defaultdict(dict)
    key = lambda point: (round(point[0], 5), round(point[1], 5))
    for lines in merged.values():
        for line in lines:
            for a, b in zip(line, line[1:]):
                ka, kb = key(a), key(b)
                if ka == kb:
                    continue
                weight = distance_km(a, b)
                graph[ka][kb] = weight
                graph[kb][ka] = weight
    nodes = list(graph)
    cell = lambda point: (int(point[0] * 20), int(point[1] * 20))
    buckets = defaultdict(list)
    for node in nodes:
        buckets[cell(node)].append(node)

    # Pieces of the network that stop a few metres short of each other are joined, so a
    # path can continue from one carriageway or way fragment to the next.
    for lines in merged.values():
        for line in lines:
            for end in (key(line[0]), key(line[-1])):
                cx, cy = cell(end)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for other in buckets.get((cx + dx, cy + dy), []):
                            if other != end and other not in graph[end]:
                                gap = distance_km(end, other)
                                if gap < 0.08:
                                    graph[end][other] = gap
                                    graph[other][end] = gap

    def nearest_node(point):
        cx, cy = cell(point)
        candidates = [n for dx in (-1, 0, 1) for dy in (-1, 0, 1) for n in buckets.get((cx + dx, cy + dy), [])]
        best = min(candidates, key=lambda n: distance_km(point, n), default=None)
        return best if best is not None and distance_km(point, best) < SNAP_KM else None

    def shortest_path(source, target, limit):
        queue = [(0.0, source)]
        dist = {source: 0.0}
        previous = {}
        while queue:
            d, node = heapq.heappop(queue)
            if node == target:
                path = [node]
                while node in previous:
                    node = previous[node]
                    path.append(node)
                return d, path[::-1]
            if d > dist.get(node, math.inf) or d > limit:
                continue
            for neighbour, weight in graph[node].items():
                nd = d + weight
                if nd < dist.get(neighbour, math.inf):
                    dist[neighbour] = nd
                    previous[neighbour] = node
                    heapq.heappush(queue, (nd, neighbour))
        return None

    def supported(road, path):
        points = evidence.get(road, [])
        if not points:
            return False
        sample = path[::3] + [path[-1]]
        near = sum(1 for p in points if any(abs(p[0] - q[0]) < 0.012 and abs(p[1] - q[1]) < 0.012 for q in sample))
        return near >= 2

    bridges = defaultdict(list)
    for road, lines in merged.items():
        ends = loose_ends(lines)
        used = set()
        pairs = sorted(
            ((distance_km(ends[i][1], ends[j][1]), i, j) for i in range(len(ends)) for j in range(i + 1, len(ends))
             if ends[i][0] != ends[j][0]),
        )
        for straight, i, j in pairs:
            if i in used or j in used or straight > 60:
                continue
            a, b = nearest_node(ends[i][1]), nearest_node(ends[j][1])
            if not a or not b:
                continue
            found = shortest_path(a, b, min(MAX_BRIDGE_KM, straight * 1.6 + 3))
            if os.environ.get("ROADS_DEBUG") and road in os.environ["ROADS_DEBUG"]:
                print(f"  [debug] {road} {ends[i][1]} -> {ends[j][1]}: reta {straight:.1f} km, caminho {found[0] if found else None}")
            if not found:
                continue
            length, path = found
            if length > straight * 1.6 + 3:
                continue
            # Accept with PRF evidence, or when it is a short, direct ride along another BR
            # (the PRF files accidents on shared stretches under only one of the numbers).
            direct = length <= 20 and length <= straight * 1.35 + 2
            evidence_ok = supported(road, path)
            if not (evidence_ok or direct):
                continue
            reason = "acidentes da PRF no trecho" if evidence_ok else "caminho direto por outra BR"
            print(f"  {road}: +{length:.1f} km entre ({path[0][1]:.3f}, {path[0][0]:.3f}) e ({path[-1][1]:.3f}, {path[-1][0]:.3f}) · {reason}")
            bridges[road].append(path)
            used.update((i, j))
    for road, pieces in sorted(bridges.items()):
        print(f"{road}: {len(pieces)} trecho(s) compartilhado(s) completado(s)")
    return bridges


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


def build(osm, roads, evidence=None):
    by_road = defaultdict(list)
    wanted = {road[3:] for road in roads}

    def numbers_in(ref):
        return {match.zfill(3) for match in REF_PATTERN.findall(ref or "")}

    # Way id -> BR numbers from the route relations it belongs to.
    relation_refs = defaultdict(set)
    for element in osm.get("elements", []):
        if element.get("type") != "relation":
            continue
        numbers = numbers_in(element.get("tags", {}).get("ref"))
        for member in element.get("members", []):
            if member.get("type") == "way":
                relation_refs[member["ref"]] |= numbers

    seen = set()
    for element in osm.get("elements", []):
        geometry = element.get("geometry")
        if element.get("type") != "way" or not geometry or element["id"] in seen:
            continue
        seen.add(element["id"])
        tags = element.get("tags", {})
        if EXCLUDED_HIGHWAYS.search(tags.get("highway", "")):
            continue
        line = [(node["lon"], node["lat"]) for node in geometry]
        for number in (numbers_in(tags.get("ref")) | relation_refs.get(element["id"], set())) & wanted:
            by_road[f"BR-{number}"].append(line)

    merged = {road: merge_lines(by_road.get(road, [])) for road in roads}
    bridged = bridge_shared_stretches(merged, evidence or {})

    features = []
    for road in roads:
        lines = merge_lines(merged[road] + bridged.get(road, []))
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
    parser.add_argument("--data", default="data", help="Folder with the prf-<year>.json snapshots used to list the BRs")
    parser.add_argument("--osm", help="Saved Overpass JSON response (skips the download)")
    parser.add_argument("--save-osm", help="Also save the downloaded Overpass response to this file")
    parser.add_argument("--output", default="data/minas-gerais-brs.geojson")
    args = parser.parse_args()

    roads = roads_from_prf(args.data)
    osm = json.loads(Path(args.osm).read_text(encoding="utf-8")) if args.osm else fetch_overpass(roads)
    if args.save_osm and not args.osm:
        Path(args.save_osm).write_text(json.dumps(osm), encoding="utf-8")
    collection = build(osm, roads, accident_points(args.data))
    output = Path(args.output)
    output.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    points = sum(len(line) for feature in collection["features"] for line in feature["geometry"]["coordinates"])
    print(f"{len(collection['features'])} BRs · {points:,} points · {output.stat().st_size / 1024:.0f} KB -> {output}")


if __name__ == "__main__":
    main()

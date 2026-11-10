#!/usr/bin/env python3
"""Download the latest official files and refresh the JSON snapshots in data/.

* PRF: finds the "Acidentes <ano> (Agrupados por ocorrência)" link on the PRF open
  data page (a Google Drive file) and downloads the ZIP.
* SEJUSP: asks the dados.mg.gov.br CKAN API for the "<ano>" CSV resource.

The snapshots are only rewritten when the data actually changed. When running in
GitHub Actions, `changed=true|false` is written to $GITHUB_OUTPUT.

Usage:
    python scripts/update_data.py [--year 2026] [--output data]
"""

import argparse
import html
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_data import build_prf_snapshot, build_sejusp_snapshot, write_snapshot  # noqa: E402

PRF_PAGE = "https://www.gov.br/prf/pt-br/acesso-a-informacao/dados-abertos/dados-abertos-da-prf"
SEJUSP_API = "https://dados.mg.gov.br/api/3/action/package_show?id=sejusp_vitimas_acidentes_transito"
USER_AGENT = "Mozilla/5.0 (compatible; minas-em-alerta-data-updater/1.0)"
# Refuse to publish a PRF snapshot that suddenly lost many records (likely a broken download).
MIN_KEEP_RATIO = 0.9


def fetch(url, timeout=180):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers.get("Content-Type", "")


def find_prf_drive_id(year):
    page, _ = fetch(PRF_PAGE)
    text = page.decode("utf-8", errors="replace")
    label_pattern = re.compile(rf"Acidentes\s+{year}\s*\(Agrupados por ocorr", re.IGNORECASE)
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if len(cells) < 2:
            continue
        label = html.unescape(re.sub(r"<[^>]+>", "", cells[0]))
        if not label_pattern.search(label):
            continue
        # The page sometimes carries a stray empty <a> pointing at another year: use the one with text.
        for href, anchor in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', cells[1], re.S):
            if not re.sub(r"<[^>]+>", "", anchor).strip():
                continue
            match = re.search(r"/file/d/([\w-]+)", href) or re.search(r"[?&]id=([\w-]+)", href)
            if match:
                return match.group(1)
    raise RuntimeError(f"Link 'Acidentes {year} (Agrupados por ocorrência)' não encontrado na página da PRF.")


def download_drive_file(file_id, destination):
    url = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"
    content, content_type = fetch(url, timeout=600)
    if "text/html" in content_type:
        # Large files may answer with a confirmation form; submit it once.
        page = content.decode("utf-8", errors="replace")
        action = re.search(r'<form[^>]+action="([^"]+)"', page)
        fields = dict(re.findall(r'<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"', page))
        if not action or not fields:
            raise RuntimeError("O Google Drive devolveu uma página HTML em vez do arquivo da PRF.")
        url = f"{html.unescape(action.group(1))}?{urllib.parse.urlencode(fields)}"
        content, content_type = fetch(url, timeout=600)
    destination.write_bytes(content)
    if not zipfile.is_zipfile(destination):
        raise RuntimeError("O arquivo baixado da PRF não é um ZIP válido.")


def find_sejusp_url(year):
    content, _ = fetch(SEJUSP_API)
    package = json.loads(content.decode("utf-8"))
    if not package.get("success"):
        raise RuntimeError("A API do dados.mg.gov.br não retornou o conjunto da SEJUSP.")
    for resource in package["result"]["resources"]:
        name = resource.get("name") or ""
        if str(year) in name and (resource.get("format") or "").upper() == "CSV":
            return resource["url"]
    raise RuntimeError(f"CSV {year} da SEJUSP não encontrado no dados.mg.gov.br.")


def comparable(payload):
    return {key: value for key, value in payload.items() if key != "generatedAt"}


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def check_road_geometry(prf, roads_path):
    roads = load_json(roads_path)
    if not roads:
        return
    drawn = {feature["properties"]["road"] for feature in roads.get("features", [])}
    missing = sorted({incident["road"] for incident in prf["incidents"]} - drawn - {"BR-000", "BR não informada"})
    if missing:
        message = f"BRs sem traçado no mapa: {', '.join(missing)}. Rode scripts/build_roads.py."
        print(f"::warning::{message}" if os.environ.get("GITHUB_ACTIONS") else f"Aviso: {message}")


def set_output(name, value):
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--output", default="data")
    args = parser.parse_args()
    output = Path(args.output)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        drive_id = find_prf_drive_id(args.year)
        print(f"PRF: baixando arquivo {drive_id} do Google Drive…")
        prf_zip = tmp / "prf.zip"
        download_drive_file(drive_id, prf_zip)
        prf = build_prf_snapshot(prf_zip)

        sejusp_url = find_sejusp_url(args.year)
        print(f"SEJUSP: baixando {sejusp_url}…")
        sejusp_csv = tmp / "sejusp.csv"
        sejusp_csv.write_bytes(fetch(sejusp_url, timeout=600)[0])
        sejusp = build_sejusp_snapshot(sejusp_csv)

    changed = []
    for name, payload in (("prf-2026.json", prf), ("sejusp-2026.json", sejusp)):
        path = output / name
        current = load_json(path)
        if current is not None and comparable(current) == comparable(payload):
            print(f"{name}: sem mudanças.")
            continue
        if name.startswith("prf") and current and current.get("incidents"):
            ratio = len(payload["incidents"]) / len(current["incidents"])
            if ratio < MIN_KEEP_RATIO:
                raise RuntimeError(
                    f"A nova base da PRF tem {len(payload['incidents'])} ocorrências contra "
                    f"{len(current['incidents'])} atuais; atualização interrompida por segurança."
                )
        write_snapshot(path, payload)
        changed.append(name)
        print(f"{name}: atualizado.")

    print(f"PRF: {len(prf['incidents']):,} ocorrências até {prf['dataThrough']}")
    print(f"SEJUSP: {sejusp['totalVictims']:,} registros até o mês {sejusp['dataThrough']}")
    check_road_geometry(prf, output / "minas-gerais-brs.geojson")
    set_output("changed", "true" if changed else "false")
    set_output("summary", f"PRF até {prf['dataThrough']}, SEJUSP até o mês {sejusp['dataThrough']}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - surface a readable failure in the Actions log
        print(f"::error::{error}" if os.environ.get("GITHUB_ACTIONS") else f"Erro: {error}", file=sys.stderr)
        sys.exit(1)

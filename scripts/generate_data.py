#!/usr/bin/env python3
"""Build small, deployable JSON snapshots from the official 2026 CSV files."""

import argparse
import csv
import json
import re
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


MINAS_BOUNDS = (-23.1, -14.1, -51.1, -39.7)
PRF_COLUMNS = {"uf", "data_inversa", "latitude", "longitude", "br"}
SEJUSP_COLUMNS = {"ano_fato", "nome_municipio_fato"}


def normalize_header(value):
    value = unicodedata.normalize("NFD", value.strip().lower())
    value = "".join(char for char in value if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", "_", value).strip("_")


def clean(value, fallback=""):
    value = (value or "").strip()
    return fallback if value.upper() in {"", "NA", "N/A", "NULL"} else value


def number(value):
    value = clean(value).replace(" ", "")
    if not value:
        return 0
    if "," in value:
        value = value.replace(".", "").replace(",", ".")
    try:
        return float(value)
    except ValueError:
        return 0


def read_csv_rows(path):
    path = Path(path)
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            candidates = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            if not candidates:
                raise ValueError(f"No CSV found in {path}")
            with archive.open(candidates[0]) as source:
                return list(csv_rows(source.read()))
    return list(csv_rows(path.read_bytes()))


def csv_rows(content):
    text = None
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            text = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ValueError("CSV encoding is not UTF-8 or Windows-1252")

    sample = text[:8192]
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=";,\t").delimiter
    except csv.Error:
        delimiter = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
    if not reader.fieldnames:
        raise ValueError("CSV has no header row")
    reader.fieldnames = [normalize_header(name) for name in reader.fieldnames]
    yield from reader


def build_prf_snapshot(path):
    rows = read_csv_rows(path)
    if not rows or not PRF_COLUMNS.issubset(rows[0]):
        raise ValueError("PRF CSV must be the 2026 dataset grouped by occurrence")

    incidents = []
    for row in rows:
        if clean(row.get("uf")).upper() != "MG" or not clean(row.get("data_inversa")).startswith("2026"):
            continue
        latitude = number(row.get("latitude"))
        longitude = number(row.get("longitude"))
        if not (MINAS_BOUNDS[0] <= latitude <= MINAS_BOUNDS[1] and MINAS_BOUNDS[2] <= longitude <= MINAS_BOUNDS[3]):
            continue

        br = clean(row.get("br"))
        road_number = re.sub(r"^BR-", "", br, flags=re.IGNORECASE)
        if road_number.isdigit() and len(road_number) <= 3:
            road_number = road_number.zfill(3)

        incidents.append({
            "id": clean(row.get("id"), f"{br}-{row.get('km', '')}-{row.get('data_inversa', '')}-{row.get('horario', '')}"),
            "date": clean(row.get("data_inversa")),
            "time": clean(row.get("horario")),
            "road": f"BR-{road_number}" if br else "BR não informada",
            "km": clean(row.get("km")),
            "city": clean(row.get("municipio"), "Município não informado"),
            "cause": clean(row.get("causa_acidente"), "Não informada"),
            "type": clean(row.get("tipo_acidente"), "Não informado"),
            "classification": clean(row.get("classificacao_acidente"), "Não informada"),
            "phase": clean(row.get("fase_dia")),
            "weather": clean(row.get("condicao_metereologica"), "Não informada"),
            "roadType": clean(row.get("tipo_pista"), "Não informado"),
            "direction": clean(row.get("sentido_via"), "Não informado"),
            "people": int(number(row.get("pessoas"))),
            "deaths": int(number(row.get("mortos"))),
            "minorInjuries": int(number(row.get("feridos_leves"))),
            "severeInjuries": int(number(row.get("feridos_graves"))),
            "latitude": latitude,
            "longitude": longitude,
        })

    if not incidents:
        raise ValueError("No geolocated PRF incidents from 2026 in Minas Gerais were found")
    return {
        "source": "PRF · Acidentes agrupados por ocorrência",
        "dataThrough": max(incident["date"] for incident in incidents),
        "incidents": incidents,
    }


def municipality_label(value):
    words = value.strip().lower().split()
    minor_words = {"da", "das", "de", "do", "dos", "e"}
    return " ".join(
        word if index and word in minor_words else word[:1].upper() + word[1:]
        for index, word in enumerate(words)
    )


def build_sejusp_snapshot(path):
    rows = read_csv_rows(path)
    if not rows or not SEJUSP_COLUMNS.issubset(rows[0]):
        raise ValueError("SEJUSP CSV must be the 2026 traffic accident victims dataset")

    municipalities = defaultdict(Counter)
    for row in rows:
        if clean(row.get("ano_fato")) != "2026":
            continue
        municipality = clean(row.get("nome_municipio_fato"))
        if not municipality:
            continue
        month = clean(row.get("mes_numerico_fato"))
        month = month.zfill(2) if month.isdigit() else "00"
        municipalities[municipality][month] += 1

    if not municipalities:
        raise ValueError("No SEJUSP victim records from 2026 were found")

    by_municipality = [
        {
            "city": municipality_label(city),
            "victims": sum(months.values()),
            "byMonth": dict(sorted(months.items())),
        }
        for city, months in sorted(municipalities.items())
    ]
    return {
        "source": "SEJUSP-MG · Vítimas de acidente de trânsito",
        "dataThrough": max(
            month for city in by_municipality for month in city["byMonth"]
        ),
        "totalVictims": sum(city["victims"] for city in by_municipality),
        "byMunicipality": by_municipality,
    }


def write_snapshot(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prf", required=True, help="PRF 2026 grouped-by-occurrence CSV or ZIP")
    parser.add_argument("--sejusp", required=True, help="SEJUSP 2026 victims CSV")
    parser.add_argument("--output", default="data", help="Directory for generated JSON snapshots")
    args = parser.parse_args()

    output = Path(args.output)
    prf = build_prf_snapshot(args.prf)
    sejusp = build_sejusp_snapshot(args.sejusp)
    write_snapshot(output / "prf-2026.json", prf)
    write_snapshot(output / "sejusp-2026.json", sejusp)
    print(f"PRF: {len(prf['incidents']):,} occurrences")
    print(f"SEJUSP: {sejusp['totalVictims']:,} victim records in {len(sejusp['byMunicipality']):,} municipalities")


if __name__ == "__main__":
    main()

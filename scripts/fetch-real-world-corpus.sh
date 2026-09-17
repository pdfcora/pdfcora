#!/usr/bin/env bash
# Downloads a spread of real-world PDFs for testing remediation (docs/…/remediation).
# Nothing here is committed: these are third-party documents, fetched on demand into
# $PDFCORA_CORPUS (default ~/pdfcora-corpus/real-world).
set -euo pipefail

DEST="${PDFCORA_CORPUS:-$HOME/pdfcora-corpus/real-world}"
UA="PDFCora-corpus/0.1 (+https://github.com/indaos/PdfiumKit-v2; testing PDF accessibility remediation)"
mkdir -p "$DEST"/{contracts,papers,reports-de,forms-de,invoices,govdocs}

get() { # url, output path
  local url="$1" out="$2"
  [ -s "$out" ] && return 0
  echo "  $(basename "$out")"
  curl -sSL --max-time 180 -A "$UA" "$url" -o "$out" || { rm -f "$out"; echo "    failed"; return 0; }
  # Anything that is not a PDF (a bot page, an error) is dropped rather than kept.
  head -c 5 "$out" | grep -q '%PDF' || { echo "    not a PDF, dropped"; rm -f "$out"; }
  sleep 1
}

echo "CUAD contracts (English, real SEC-filed contracts)"
python3 - "$DEST/contracts" <<'PY'
import json, os, sys, urllib.parse, urllib.request
dest = sys.argv[1]
api = "https://huggingface.co/api/datasets/theatticusproject/cuad/tree/main/CUAD_v1/full_contract_pdf/Part_I"
def listing(path):
    with urllib.request.urlopen(f"https://huggingface.co/api/datasets/theatticusproject/cuad/tree/main/{urllib.parse.quote(path)}") as r:
        return json.load(r)
wanted, seen = 15, 0
for folder in listing("CUAD_v1/full_contract_pdf/Part_I"):
    if folder["type"] != "directory":
        continue
    for entry in listing(folder["path"])[:2]:
        if seen >= wanted or entry["type"] != "file":
            continue
        name = os.path.basename(entry["path"]).replace(" ", "_")
        out = os.path.join(dest, name)
        if not os.path.exists(out):
            url = "https://huggingface.co/datasets/theatticusproject/cuad/resolve/main/" + urllib.parse.quote(entry["path"])
            print("  " + name)
            urllib.request.urlretrieve(url, out)
        seen += 1
PY

echo "arXiv papers (multi-column, English)"
for id in 2401.00001 2402.00015 2403.00024 2404.00102 2405.00201 2406.00043 2407.00087 2408.00152; do
  get "https://arxiv.org/pdf/$id" "$DEST/papers/arxiv-$id.pdf"
done

echo "EU Official Journal acts (multi-column, English and German)"
# The Publications Office's machine-readable endpoint; the eur-lex.europa.eu web pages
# refuse automated requests.
for celex in 32024R1183 32024R1689 32023R2854 32022R2065; do
  for lang in eng deu; do
    out="$DEST/papers/eu-oj-$celex-$lang.pdf"
    [ -s "$out" ] && continue
    echo "  $(basename "$out")"
    curl -sSL --max-time 180 -A "$UA" -H "Accept: application/pdf" -H "Accept-Language: $lang" \
      "http://publications.europa.eu/resource/celex/$celex" -o "$out" || rm -f "$out"
    head -c 5 "$out" 2>/dev/null | grep -q '%PDF' || rm -f "$out"
    sleep 1
  done
done

echo "Bundesbank monthly reports (German, table-heavy)"
get "https://www.bundesbank.de/resource/blob/781624/6a549bf42fdce0a2206ec31c7d5c63a3/472B63F073F071307366337C94F8C870/2023-07-monatsbericht-data.pdf" \
    "$DEST/reports-de/bundesbank-2023-07.pdf"

echo "Statistical reports (German)"
python3 - "$DEST/reports-de" "$UA" <<'PY'
import os, re, sys, time, urllib.request
dest, ua = sys.argv[1], sys.argv[2]
pages = [
  "https://www.laiv-mv.de/Statistik/Ver%C3%B6ffentlichungen/Statistische-Berichte/",
  "https://www.destatis.de/DE/Themen/Wirtschaft/Volkswirtschaftliche-Gesamtrechnungen-Inlandsprodukt/Publikationen/_publikationen-innen-statistischer-bericht.html",
]
found = 0
for page in pages:
    try:
        req = urllib.request.Request(page, headers={"User-Agent": ua})
        html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    except Exception as e:
        print(f"    {page}: {e}")
        continue
    links = re.findall(r'href="([^"]+\.pdf[^"]*)"', html, re.I)
    base = page[: page.rindex("/") + 1]
    for link in links[:6]:
        url = link if link.startswith("http") else ("https://" + page.split("/")[2] + link if link.startswith("/") else base + link)
        name = re.sub(r"[^A-Za-z0-9._-]", "_", url.split("/")[-1].split("?")[0])[:80]
        out = os.path.join(dest, name)
        if os.path.exists(out):
            continue
        try:
            print("  " + name)
            urllib.request.urlretrieve(url, out)
            found += 1
            time.sleep(1)
        except Exception as e:
            print(f"    {name}: {e}")
print(f"  {found} statistical report(s)")
PY

echo "Invoices"
get "https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/style-guide-qr-bill-en.pdf" \
    "$DEST/invoices/six-qr-bill-style-guide.pdf"

echo "GovDocs1 (mixed real-world government files)"
# One 1000-file subset, from which only the PDFs are kept.
ZIP="$DEST/govdocs/000.zip"
if [ ! -d "$DEST/govdocs/000" ]; then
  [ -s "$ZIP" ] || curl -sSL --max-time 900 -A "$UA" \
    "https://downloads.digitalcorpora.org/corpora/files/govdocs1/zipfiles/000.zip" -o "$ZIP"
  mkdir -p "$DEST/govdocs/000"
  unzip -q -j -o "$ZIP" '*.pdf' -d "$DEST/govdocs/000" || true
  rm -f "$ZIP"
fi

echo
echo "Corpus in $DEST:"
find "$DEST" -name '*.pdf' | wc -l

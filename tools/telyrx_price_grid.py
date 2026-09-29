#!/usr/bin/env python3
"""
Collect every strength x quantity price from telyrx.com product pages.

TelyRx runs Magento. Each product page embeds its option matrix (strengths, quantities,
and the price of every combination) in a <script type="text/x-magento-init"> block
("jsonConfig"). This script reads that block; no browser needed.

Usage:
  pip install requests beautifulsoup4
  python telyrx_price_grid.py                 # crawl category pages -> telyrx_price_grid.csv
  python telyrx_price_grid.py --urls urls.txt # or give product URLs yourself

Be polite: one request every 2 seconds by default, and check telyrx.com's terms of use
and robots.txt before running. Prices change; re-run before each price update.
"""
import argparse, csv, json, re, sys, time
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup

BASE = "https://telyrx.com"
CATEGORY_PAGES = ["/health/chronic-conditions", "/health/flu-and-infections", "/health/digestive-health",
    "/health/skin-hair", "/health/womens-health", "/health/men-health", "/health/lifestyle",
    "/health/weight-loss", "/supplements", "/doctors-note"]
PRODUCT_RE = re.compile(r"^https://telyrx\.com/(medications|supplements|doctors-note)/[a-z0-9\-]+/?$")
HEADERS = {"User-Agent": "Mozilla/5.0 (price research; contact: support@delivermymedications.com)"}

def get(session, url, delay):
    time.sleep(delay)
    r = session.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.text

def product_urls(session, delay):
    urls = set()
    for path in CATEGORY_PAGES:
        soup = BeautifulSoup(get(session, BASE + path, delay), "html.parser")
        for a in soup.select("a[href]"):
            href = urljoin(BASE, a["href"].split("?")[0])
            if PRODUCT_RE.match(href):
                urls.add(href.rstrip("/"))
    return sorted(urls)

def find_json_config(html):
    """Return Magento's configurable-product jsonConfig dict, or None."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all("script", {"type": "text/x-magento-init"}):
        try:
            data = json.loads(tag.string or "")
        except ValueError:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                if "jsonConfig" in node and isinstance(node["jsonConfig"], dict) and "attributes" in node["jsonConfig"]:
                    return node["jsonConfig"]
                if "attributes" in node and "optionPrices" in node:
                    return node
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    return None

def rows_from_config(cfg):
    """Expand jsonConfig into (strength, quantity, price) rows."""
    attrs = list(cfg["attributes"].values())
    # Heuristic: the attribute whose label mentions dos/strength is the strength; the other is quantity.
    def is_dose(a): return re.search(r"dos|strength|select dosage", a.get("label", ""), re.I)
    dose_attr = next((a for a in attrs if is_dose(a)), attrs[0])
    qty_attrs = [a for a in attrs if a is not dose_attr]
    prices = cfg.get("optionPrices", {})
    out = []
    for d in dose_attr["options"]:
        d_products = set(d.get("products", []))
        if not qty_attrs:
            for pid in d_products:
                amt = prices.get(pid, {}).get("finalPrice", {}).get("amount")
                if amt is not None:
                    out.append((d["label"], "", float(amt)))
                    break
            continue
        for q in qty_attrs[0]["options"]:
            both = d_products & set(q.get("products", []))
            for pid in both:
                amt = prices.get(pid, {}).get("finalPrice", {}).get("amount")
                if amt is not None:
                    out.append((d["label"], q["label"], float(amt)))
                    break
    return out

def name_from(html):
    soup = BeautifulSoup(html, "html.parser")
    og = soup.find("meta", {"property": "og:name"}) or soup.find("meta", {"name": "og:name"})
    if og and og.get("content"): return og["content"]
    h = soup.find("h1"); return h.get_text(strip=True) if h else ""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", help="text file of product URLs, one per line")
    ap.add_argument("--out", default="telyrx_price_grid.csv")
    ap.add_argument("--delay", type=float, default=2.0)
    args = ap.parse_args()
    s = requests.Session()
    urls = [u.strip() for u in open(args.urls)] if args.urls else product_urls(s, args.delay)
    print(f"{len(urls)} product pages", file=sys.stderr)
    missing = []
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["url", "name", "strength", "quantity", "price"])
        for i, url in enumerate(urls, 1):
            try:
                html = get(s, url, args.delay)
            except Exception as e:
                missing.append((url, str(e))); continue
            cfg = find_json_config(html)
            rows = rows_from_config(cfg) if cfg else []
            if not rows:
                missing.append((url, "no option matrix found")); continue
            name = name_from(html)
            for d, q, p in rows:
                w.writerow([url, name, d, q, f"{p:.2f}"])
            print(f"[{i}/{len(urls)}] {name}: {len(rows)} prices", file=sys.stderr)
    if missing:
        with open("telyrx_price_grid_missing.txt", "w") as f:
            for u, why in missing: f.write(f"{u}\t{why}\n")
        print(f"{len(missing)} pages had no matrix; see telyrx_price_grid_missing.txt", file=sys.stderr)

if __name__ == "__main__":
    main()

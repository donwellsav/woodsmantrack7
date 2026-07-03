#!/usr/bin/env python3
"""Extract per-chapter plain text from the EPUB for alignment."""
import json, re, html
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EPUB = ROOT / "epub" / "book.epub"
MANIFEST = ROOT / "data" / "chapters.json"
TEXT_DIR = ROOT / "data" / "text"
TEXT_DIR.mkdir(parents=True, exist_ok=True)

with open(MANIFEST) as f:
    manifest = json.load(f)

with zipfile.ZipFile(EPUB) as z:
    for ch in manifest["chapters"]:
        if ch["type"] == "front-matter":
            continue
        # pandoc names chapters ch002.xhtml etc. (ch001 is title page, skipped)
        # our manifest id is e.g. "ch002" and epub_href is "text/ch002.xhtml"
        href = ch["epub_href"]
        try:
            xml = z.read(f"EPUB/{href}").decode("utf-8", errors="replace")
        except KeyError:
            print(f"missing: {href}")
            continue
        # strip everything except text
        # remove <head>...</head>
        xml = re.sub(r"<head>.*?</head>", "", xml, flags=re.S | re.I)
        # convert <br>, </p>, headings to spaces/newlines
        xml = re.sub(r"<br\s*/?>", "\n", xml, flags=re.I)
        xml = re.sub(r"</(p|div|h[1-6]|li|blockquote)>", "\n", xml, flags=re.I)
        # strip all remaining tags
        text = re.sub(r"<[^>]+>", "", xml)
        text = html.unescape(text)
        # normalize whitespace
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n\n", text)
        text = text.strip()

        out = TEXT_DIR / f"{ch['id']}.txt"
        out.write_text(text)
        print(f"  {ch['id']}: {len(text)} chars -> {out.name}")

print(f"\n{len(list(TEXT_DIR.glob('*.txt')))} text files in {TEXT_DIR}")
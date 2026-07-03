#!/usr/bin/env python3
"""Build chapters.json: maps EPUB chapters -> MP3 audio files with durations."""
import json, subprocess, os, re, zipfile, html
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EPUB = ROOT / "epub" / "book.epub"
AUDIO_SRC = ROOT.parent / "ElevenLabs_woodsman_track_seven_6x9_kdp_v2_with_toc_docx"
OUT = ROOT / "data" / "chapters.json"

# Chapters flagged as title-announcements only (audio ~2.5s, no full narration)
TITLE_ONLY = {"The Park", "The God", "The Room", "The Bones", "The Showcase"}

def get_chapter_titles():
    """Read chapter order + titles from EPUB nav."""
    z = zipfile.ZipFile(EPUB)
    nav = z.read("EPUB/nav.xhtml").decode("utf-8", errors="replace")
    # nav points: <a href="text/ch0XX.xhtml">Title</a>
    # entries look like: href="text/ch002.xhtml#the-door"><strong>The Door</strong></a>
    entries = re.findall(r'href="text/(ch\d+\.xhtml)[^"]*"[^>]*>(.*?)</a>', nav)
    chapters = []
    for href, raw in entries:
        title = html.unescape(re.sub(r'<[^>]+>', '', raw)).strip()
        if href == "ch001.xhtml":  # title page, not a real chapter
            continue
        if title:
            chapters.append((href, title))
    return chapters

def duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True
    )
    try: return round(float(r.stdout.strip()), 2)
    except: return 0.0

def main():
    chapters = get_chapter_titles()
    mp3s = sorted(p for p in AUDIO_SRC.glob("*.mp3"))

    # 01_Introduction.mp3 = front matter; rest map 1:1 in order
    intro = next((p for p in mp3s if "Introduction" in p.name), None)
    chapter_mp3s = [p for p in mp3s if p is not intro]

    assert len(chapters) == len(chapter_mp3s), \
        f"mismatch: {len(chapters)} epub chapters vs {len(chapter_mp3s)} chapter mp3s"

    manifest = {"title": "Woodsman: Track Seven", "chapters": []}

    if intro:
        manifest["chapters"].append({
            "id": "intro",
            "title": "Introduction",
            "audio": intro.name,
            "duration": duration(intro),
            "type": "front-matter",
        })

    for (href, title), mp3 in zip(chapters, chapter_mp3s):
        # match epub chapter file to mp3 by verifying title substring
        kind = "title-only" if title in TITLE_ONLY else "full"
        manifest["chapters"].append({
            "id": href.replace(".xhtml", ""),
            "title": title,
            "epub_href": f"text/{href}",
            "audio": mp3.name,
            "duration": duration(mp3),
            "type": kind,
        })

    OUT.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    full = sum(c["duration"] for c in manifest["chapters"])
    flagged = [c["title"] for c in manifest["chapters"] if c["type"] == "title-only"]
    print(f"wrote {OUT}")
    print(f"chapters: {len(manifest['chapters'])} | total audio: {full/60:.1f} min")
    print(f"title-only (no full audio): {flagged}")

if __name__ == "__main__":
    main()

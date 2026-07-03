#!/usr/bin/env python3
"""Run forced alignment: per (chapter_text, chapter_audio) -> word timings JSON.

Usage:
  python3 align.py                  # align all full chapters
  python3 align.py ch002            # align one chapter (test)
"""
import sys, json, time
from pathlib import Path
import stable_whisper

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "data" / "chapters.json"
TEXT_DIR = ROOT / "data" / "text"
AUDIO_DIR = ROOT.parent / "ElevenLabs_woodsman_track_seven_6x9_kdp_v2_with_toc_docx"
OUT_DIR = ROOT / "data" / "timings"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_SIZE = "base.en"

def align_one(model, ch):
    cid = ch["id"]
    text_path = TEXT_DIR / f"{cid}.txt"
    audio_path = AUDIO_DIR / ch["audio"]
    out_path = OUT_DIR / f"{cid}.json"

    if not text_path.exists():
        print(f"  SKIP {cid}: no text file")
        return False
    if not audio_path.exists():
        print(f"  SKIP {cid}: no audio")
        return False

    text = text_path.read_text().strip()
    if len(text) < 100:
        print(f"  SKIP {cid}: text too short ({len(text)} chars) -- title-only chapter")
        return False

    if out_path.exists():
        print(f"  SKIP {cid}: already aligned -> {out_path.name}")
        return True

    print(f"  ALIGN {cid}: {ch['audio']} ({len(text)} chars)")
    t0 = time.time()
    try:
        result = model.align(
            str(audio_path),
            text,
            language="en",
            original_split=True,
        )
    except Exception as e:
        print(f"    FAIL: {e}")
        return False
    dt = time.time() - t0
    print(f"    OK in {dt:.1f}s")

    words = []
    for seg in result.segments:
        for w in (seg.words or []):
            words.append({
                "start": round(float(w.start), 3),
                "end":   round(float(w.end), 3),
                "word":  w.word.strip(),
            })
    out_path.write_text(json.dumps({
        "chapter_id": cid,
        "audio": ch["audio"],
        "duration": ch["duration"],
        "words": words,
        "segments": [
            {"start": round(float(s.start), 3), "end": round(float(s.end), 3), "text": s.text.strip()}
            for s in result.segments
        ],
    }, indent=2, ensure_ascii=False))
    print(f"    wrote {out_path.name}: {len(words)} words, {len(result.segments)} segments")
    return True


def main():
    targets = sys.argv[1:] or None
    with open(MANIFEST) as f:
        manifest = json.load(f)

    chapters = [c for c in manifest["chapters"] if c["type"] != "front-matter"]
    if targets:
        chapters = [c for c in chapters if c["id"] in targets]

    print(f"Loading whisper model: {MODEL_SIZE} (first run downloads ~150MB)")
    model = stable_whisper.load_model(MODEL_SIZE)

    ok = fail = 0
    for ch in chapters:
        if align_one(model, ch):
            ok += 1
        else:
            fail += 1
    print(f"\nDone: {ok} ok, {fail} failed")


if __name__ == "__main__":
    main()
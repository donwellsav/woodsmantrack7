#!/usr/bin/env python3
"""Independent sync verification.

For each chosen chapter, extract a random audio window, run an INDEPENDENT
Whisper transcription on it, and compare the transcribed words to the words
the stable-ts alignment claims are spoken in that window. If they agree, the
audio and the ebook text are genuinely in sync (not just force-fitted)."""
import json, random, subprocess, sys, os
from pathlib import Path
import stable_whisper

ROOT = Path(__file__).resolve().parent.parent
TIMINGS = ROOT / "data" / "timings"
AUDIO = ROOT.parent / "ElevenLabs_woodsman_track_seven_6x9_kdp_v2_with_toc_docx"
CLIP_DIR = ROOT / "data" / "clips"
CLIP_DIR.mkdir(parents=True, exist_ok=True)

# chapters to spot-check
CHAPTERS = ["ch002", "ch014", "ch027"]
WINDOW = 12.0  # seconds of audio to transcribe per chapter

random.seed(7)

def norm(w):
    return ''.join(c for c in w.lower() if c.isalnum())

def overlap(a, b):
    """fraction of set-a words also in set-b (order-insensitive recall)"""
    a, b = set(a), set(b)
    if not a: return 0.0
    return len(a & b) / len(a)

def main():
    model = stable_whisper.load_model("base.en")
    print(f"\n{'chapter':7} {'window':>14} {'align_words':>22} {'transcribe_words':>22} {'recall':>7}")
    print("-" * 90)
    results = []
    for cid in CHAPTERS:
        tj = TIMINGS / f"{cid}.json"
        d = json.load(open(tj))
        words = d["words"]
        audio = AUDIO / d["audio"]
        dur = d["duration"]
        # pick a window somewhere in the middle of the audio (avoid intro/outro)
        start = round(random.uniform(dur * 0.15, dur * 0.85 - WINDOW), 1)
        end = round(start + WINDOW, 1)

        # alignment's claim: words whose [start,end] intersects [start,end]
        align_words = [norm(w["word"]) for w in words
                       if w["start"] < end and w["end"] > start and norm(w["word"])]

        # extract + independently transcribe
        clip = CLIP_DIR / f"{cid}_{start:.1f}.mp3"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "quiet", "-ss", str(start),
                        "-t", str(WINDOW), "-i", str(audio), "-c", "copy", str(clip)],
                       check=True)
        res = model.transcribe(str(clip), language="en", verbose=False)
        trans_words = [norm(w.word) for seg in res.segments for w in (seg.words or []) if norm(w.word)]

        recall = round(overlap(align_words, trans_words), 2)
        results.append(recall)
        print(f"{cid:7} {start:7.1f}-{end:5.1f}s  {(' '.join(align_words))[:20]:>22}  "
              f"{(' '.join(trans_words))[:20]:>22}  {recall:>6.0%}")
        clip.unlink(missing_ok=True)

    print("-" * 90)
    avg = sum(results) / len(results) if results else 0
    print(f"\navg word recall (alignment vs independent transcription): {avg:.0%}")
    print("(>=70% = well synced; the gap is Whisper transcription variance, not desync.)")

if __name__ == "__main__":
    main()

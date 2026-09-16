#!/usr/bin/env python3
"""Regenerate the macOS app icon (icons/icon.icns and the source PNGs).

The artwork is a white squircle plate with the candle mark on it, on a
transparent canvas. It reaches the Dock through set_dock_icon in src/main.rs,
which hands icons/icon.png to NSApplication at launch: macOS 26 draws every
icon that comes from the bundle (.icns or asset catalog) on its own rounded
compatibility plate, which we cannot size or colour, but a runtime-set image
is drawn as-is. So the plate here is OURS, drawn at the same 84% of the tile
the system uses for its neighbours, with the mark at ~58% of the plate, where
a stock glyph sits. The bare mark with no plate was tried: teal and red on
the gray Dock is hard to read at tile size.

The .icns is what Finder and the closed-app tile show, plated again by the
system; that nesting only shows there.

This draws the candle mark on that grid (4x supersampled) and packs an
.iconset -> .icns. Run from `tauri-shell/`:

    ../backend/.venv/bin/python scripts/gen-macos-icon.py

icon.png is compiled into the binary (include_bytes! in set_dock_icon), so a
change here needs `cargo tauri build`, not just a file swap.
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons" / "icon.icns"

CANVAS = 1024  # Apple's icon grid
BODY = CANVAS  # the mark is laid out on the whole canvas
SS = 4  # supersampling factor

WHITE = (255, 255, 255, 255)
BORDER = (226, 230, 234, 255)
PLATE = 0.84  # plate side as a fraction of the canvas (measured off Tahoe's tile)
PLATE_R = 0.225  # corner radius as a fraction of the plate: Apple's squircle, near enough
BORDER_W = 2 / 1024  # hairline, so the plate still has an edge on a white Dock
TEAL = (38, 166, 154, 255)
RED = (239, 83, 80, 255)

# Artwork geometry, as fractions of the body, measured off the original 512px
# icon so the mark itself is unchanged.
WICK_W = 21 / 512
WICK_TOP = 129 / 512
WICK_BOTTOM = 382 / 512
CANDLE_W = 84 / 512
CANDLE_TOP = 199.5 / 512
CANDLE_BOTTOM = 311.5 / 512
CANDLE_R = 19.5 / 512
TEAL_CX = 206.5 / 512
RED_CX = 305.5 / 512

# The mark is centred on 0.5 in both axes, so scaling about that point keeps it
# centred. 0.98 puts its height at ~58% of the plate.
MARK_SCALE = 0.98


def draw_master() -> Image.Image:
    size = CANVAS * SS
    body = BODY * SS
    off = (size - body) / 2

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    plate = PLATE * size
    p0 = (size - plate) / 2
    d.rounded_rectangle(
        (p0, p0, p0 + plate - 1, p0 + plate - 1),
        radius=PLATE_R * plate,
        fill=WHITE,
        outline=BORDER,
        width=max(1, round(BORDER_W * size)),
    )


    def b(frac: float) -> float:  # body fraction -> absolute px, scaled about centre
        return off + (0.5 + (frac - 0.5) * MARK_SCALE) * body

    def w(frac: float) -> float:  # a width/radius fraction -> absolute px
        return frac * body * MARK_SCALE

    for cx, color in ((TEAL_CX, TEAL), (RED_CX, RED)):
        half_w = w(WICK_W) / 2
        d.rounded_rectangle(
            (b(cx) - half_w, b(WICK_TOP), b(cx) + half_w, b(WICK_BOTTOM)),
            radius=half_w,
            fill=color,
        )
        half_c = w(CANDLE_W) / 2
        d.rounded_rectangle(
            (b(cx) - half_c, b(CANDLE_TOP), b(cx) + half_c, b(CANDLE_BOTTOM)),
            radius=w(CANDLE_R),
            fill=color,
        )

    return img.resize((CANVAS, CANVAS), Image.LANCZOS)


PNG_SIZES = {
    "icon.png": 512,
    "128x128@2x.png": 256,
    "128x128.png": 128,
    "64x64.png": 64,
    "32x32.png": 32,
}


def main() -> None:
    master = draw_master()
    icons = OUT.parent
    for name, px in PNG_SIZES.items():
        master.resize((px, px), Image.LANCZOS).save(icons / name)
        print(f"wrote {icons / name}")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = pathlib.Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for pt in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = pt * scale
                name = f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
                master.resize((px, px), Image.LANCZOS).save(iconset / name)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(OUT)], check=True
        )
    print(f"wrote {OUT}")
    if shutil.which("sips"):
        subprocess.run(["sips", "-g", "pixelWidth", str(OUT)], check=True)


if __name__ == "__main__":
    main()

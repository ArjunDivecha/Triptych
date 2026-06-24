#!/usr/bin/env python3
"""
=============================================================================
SCRIPT NAME: gen_icon.py
=============================================================================

INPUT FILES:
- None (the icon is drawn programmatically with PIL).

OUTPUT FILES:
- /Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/assets/icon-1024.png
  Master 1024x1024 icon image (kept for reference/regeneration).
- /Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/Triptych.app/Contents/Resources/Triptych.icns
  macOS icon bundle built from the master image via sips + iconutil.
- (temporary) /tmp/Triptych.iconset/  - intermediate per-size PNGs,
  removed after the .icns is built.

VERSION: 1.0
LAST UPDATED: 2026-06-10
AUTHOR: Arjun Divecha

DESCRIPTION:
Draws the Triptych app icon - a light rounded square containing three
white panels (the "triptych"): a green factor-signal line, a blue
cumulative-return line, and green/amber decile bars. Renders at
1024x1024, then uses macOS `sips` to produce every size the iconset
needs and `iconutil` to compile the final .icns into the app bundle.

DEPENDENCIES:
- Pillow (PIL)
- macOS command line tools: sips, iconutil

USAGE:
python3 gen_icon.py
=============================================================================
"""

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

APP_ASSETS = Path("/Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/assets")
ICNS_OUT = Path(
    "/Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/"
    "Triptych.app/Contents/Resources/Triptych.icns"
)
MASTER_PNG = APP_ASSETS / "icon-1024.png"
ICONSET_DIR = Path("/tmp/Triptych.iconset")

S = 1024

BG = (243, 246, 244, 255)        # light sage
BG_BORDER = (195, 209, 202, 255)
PANEL = (255, 255, 255, 255)
PANEL_BORDER = (219, 228, 223, 255)
GREEN = (15, 126, 99, 255)
BLUE = (17, 79, 136, 255)
BAR_GREEN = (24, 116, 63, 255)
BAR_AMBER = (245, 166, 35, 255)


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded app square (Apple-style margin)
    m = 70
    d.rounded_rectangle([m, m, S - m, S - m], radius=200, fill=BG, outline=BG_BORDER, width=8)

    # Three vertical panels
    panel_w, gap = 210, 38
    total = 3 * panel_w + 2 * gap
    x0 = (S - total) // 2
    y0, y1 = 240, S - 240

    for i in range(3):
        x = x0 + i * (panel_w + gap)
        d.rounded_rectangle([x, y0, x + panel_w, y1], radius=34, fill=PANEL, outline=PANEL_BORDER, width=6)

    def panel_x(i, frac):
        x = x0 + i * (panel_w + gap)
        pad = 34
        return x + pad + frac * (panel_w - 2 * pad)

    def panel_y(frac):
        pad = 46
        return y0 + pad + frac * (y1 - y0 - 2 * pad)

    # Panel 1: factor signal line (green)
    pts1 = [(0.0, 0.62), (0.3, 0.18), (0.55, 0.45), (0.78, 0.3), (1.0, 0.05)]
    line1 = [(panel_x(0, fx), panel_y(fy)) for fx, fy in pts1]
    d.line(line1, fill=GREEN, width=26, joint="curve")

    # Panel 2: cumulative return line (blue)
    pts2 = [(0.0, 0.85), (0.25, 0.6), (0.45, 0.68), (0.7, 0.35), (1.0, 0.12)]
    line2 = [(panel_x(1, fx), panel_y(fy)) for fx, fy in pts2]
    d.line(line2, fill=BLUE, width=26, joint="curve")

    # Panel 3: decile bars (two green, one amber = current decile)
    bar_specs = [(0.12, 0.55, BAR_GREEN), (0.42, 0.35, BAR_GREEN), (0.72, 0.12, BAR_AMBER)]
    for fx, fy_top, color in bar_specs:
        bx0 = panel_x(2, fx)
        bx1 = panel_x(2, fx + 0.18)
        d.rounded_rectangle([bx0, panel_y(fy_top), bx1, panel_y(1.0)], radius=14, fill=color)

    return img


def build_icns() -> None:
    if ICONSET_DIR.exists():
        shutil.rmtree(ICONSET_DIR)
    ICONSET_DIR.mkdir(parents=True)

    sizes = [16, 32, 64, 128, 256, 512]
    for size in sizes:
        for scale in (1, 2):
            px = size * scale
            suffix = "" if scale == 1 else "@2x"
            out = ICONSET_DIR / f"icon_{size}x{size}{suffix}.png"
            subprocess.run(
                ["sips", "-z", str(px), str(px), str(MASTER_PNG), "--out", str(out)],
                check=True,
                capture_output=True,
            )

    ICNS_OUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET_DIR), "-o", str(ICNS_OUT)],
        check=True,
    )
    shutil.rmtree(ICONSET_DIR)
    print(f"Wrote {ICNS_OUT}")


def main() -> None:
    img = draw_master()
    MASTER_PNG.parent.mkdir(parents=True, exist_ok=True)
    img.save(MASTER_PNG)
    print(f"Wrote {MASTER_PNG}")
    build_icns()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate Bathroom Party icons from bp-logo.svg."""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "bp-logo.svg"


def rasterize_logo(size: int) -> Image.Image:
    render_size = max(size * 4, 512)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        subprocess.run(
            ["qlmanage", "-t", "-s", str(render_size), "-o", str(tmp_path), str(LOGO)],
            capture_output=True,
            check=True,
        )
        src = Image.open(tmp_path / f"{LOGO.name}.png").convert("RGBA")
    return src.resize((size, size), Image.LANCZOS)


def main():
    for size in (512, 128, 48, 16):
        name = f"icon{size}.png" if size != 512 else "icon-source-512.png"
        out = ROOT / name
        rasterize_logo(size).save(out, "PNG", optimize=True)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()

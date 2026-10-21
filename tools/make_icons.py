"""Render the toolbar icons (blue rounded square with a white 译). Needs Pillow.
usage: python3 tools/make_icons.py extension/icons [path/to/NotoSansCJK-Bold.ttc]"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1])
font_path = sys.argv[2] if len(sys.argv) > 2 else "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
for size in (16, 32, 48, 128):
    scale = 8
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=big // 5, fill=(9, 105, 218, 255))
    font = ImageFont.truetype(font_path, int(big * 0.72), index=2)  # index 2 = SC
    draw.text((big / 2, big / 2), "译", font=font, fill="white", anchor="mm")
    img.resize((size, size), Image.LANCZOS).save(out / f"{size}.png", optimize=True)

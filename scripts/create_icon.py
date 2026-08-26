#!/usr/bin/env python3

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "assets" / "snowflake.ico"


def create_icon():
    size = 256
    image = Image.new("RGBA", (size, size), (237, 247, 239, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((18, 18, 238, 238), radius=54, fill=(62, 132, 87, 255))
    center = size // 2
    color = (246, 252, 247, 255)
    width = 13
    for angle in (0, 60, 120):
        import math
        radians = math.radians(angle)
        dx = math.cos(radians) * 76
        dy = math.sin(radians) * 76
        draw.line((center - dx, center - dy, center + dx, center + dy), fill=color, width=width)
        for direction in (-1, 1):
            px = center + direction * dx * 0.62
            py = center + direction * dy * 0.62
            for branch in (-38, 38):
                branch_angle = radians + math.radians(branch) + (math.pi if direction < 0 else 0)
                bx = px - math.cos(branch_angle) * 30
                by = py - math.sin(branch_angle) * 30
                draw.line((px, py, bx, by), fill=color, width=9)
    draw.ellipse((113, 113, 143, 143), fill=(219, 240, 224, 255))
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    image.save(TARGET, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    create_icon()
    print(TARGET)

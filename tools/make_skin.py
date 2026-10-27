"""Draws the characters' skin for mods/ai_bot/textures: a woman with long hair and a dress, in three 64x32 layers
for Minetest Game's player model (character.b3d, the classic 64x32 skin layout):

  ai_bot_skin.png   skin, face, boots and the dress's dark trim, in their own colours
  ai_bot_dress.png  where the dress is, in greys (white = full colour, grey = shade), tinted per character
  ai_bot_hair.png   where the hair is, the same way

The mod tints the two masks with each character's colours ([multiply), so one drawing serves every character.
  python3 tools/make_skin.py
"""
import struct
import zlib
from pathlib import Path

W, H = 64, 32
OUT = Path(__file__).resolve().parent.parent / 'mods' / 'ai_bot' / 'textures'


def png(path, px):
    raw = b''.join(b'\x00' + bytes(c for p in row for c in p) for row in px)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def layer():
    return [[(0, 0, 0, 0) for _ in range(W)] for _ in range(H)]


def fill(px, x0, y0, w, h, c):
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            px[y][x] = c


# The classic layout: each box part's faces as (x, y, w, h).
HEAD = {'top': (8, 0, 8, 8), 'bottom': (16, 0, 8, 8), 'right': (0, 8, 8, 8), 'front': (8, 8, 8, 8),
        'left': (16, 8, 8, 8), 'back': (24, 8, 8, 8)}
BODY = {'top': (20, 16, 8, 4), 'bottom': (28, 16, 8, 4), 'right': (16, 20, 4, 12), 'front': (20, 20, 8, 12),
        'left': (28, 20, 4, 12), 'back': (32, 20, 8, 12)}
ARM = {'top': (44, 16, 4, 4), 'bottom': (48, 16, 4, 4), 'right': (40, 20, 4, 12), 'front': (44, 20, 4, 12),
       'left': (48, 20, 4, 12), 'back': (52, 20, 4, 12)}
LEG = {'top': (4, 16, 4, 4), 'bottom': (8, 16, 4, 4), 'right': (0, 20, 4, 12), 'front': (4, 20, 4, 12),
       'left': (8, 20, 4, 12), 'back': (12, 20, 4, 12)}

SKIN, SKIN_SHADE = (236, 188, 150, 255), (214, 164, 128, 255)
EYE_WHITE, EYE, LASH = (250, 250, 250, 255), (60, 90, 140, 255), (40, 28, 24, 255)
MOUTH, BLUSH = (196, 90, 96, 255), (232, 156, 140, 255)
BOOT, BOOT_SOLE = (70, 46, 34, 255), (44, 30, 22, 255)
FULL, SHADE, DARK = (255, 255, 255, 255), (214, 214, 214, 255), (170, 170, 170, 255)

skin, dress, hair = layer(), layer(), layer()

# Skin everywhere it shows: head, arms, legs.
for part in (HEAD, ARM, LEG):
    for face, (x, y, w, h) in part.items():
        fill(skin, x, y, w, h, SKIN_SHADE if face in ('right', 'left', 'back', 'bottom') else SKIN)

# The face (front of the head, x 8..15, y 8..15): eyes with lashes, cheeks, a smile.
for ex in (9, 13):
    skin[11][ex] = EYE_WHITE
    skin[11][ex + 1] = EYE
    skin[10][ex] = LASH
    skin[10][ex + 1] = LASH
skin[13][9] = BLUSH
skin[13][14] = BLUSH
skin[13][11] = MOUTH
skin[13][12] = MOUTH

# The dress: the whole body, short sleeves (the top of the arms) and a skirt to the knee (the top of the legs).
for face, (x, y, w, h) in BODY.items():
    fill(dress, x, y, w, h, SHADE if face in ('right', 'left', 'back') else FULL)
for face, (x, y, w, h) in ARM.items():
    if face == 'top':
        fill(dress, x, y, w, h, FULL)
    elif face != 'bottom':
        fill(dress, x, y, w, 4, SHADE if face != 'front' else FULL)
for face, (x, y, w, h) in LEG.items():
    if face == 'top':
        fill(dress, x, y, w, h, FULL)
    elif face != 'bottom':
        fill(dress, x, y, w, 6, SHADE if face != 'front' else FULL)
        for xx in range(x, x + w):  # a darker hem
            dress[y + 6][xx] = DARK
# A waist sash and a collar, a shade darker.
fill(dress, 20, 25, 8, 1, DARK)
fill(dress, 32, 25, 8, 1, DARK)
fill(dress, 22, 20, 4, 1, DARK)

# Boots: the lower legs below the skirt.
for face, (x, y, w, h) in LEG.items():
    if face in ('right', 'front', 'left', 'back'):
        fill(skin, x, y + 8, w, 4, BOOT)
        fill(skin, x, y + 11, w, 1, BOOT_SOLE)
    if face == 'bottom':
        fill(skin, x, y, w, h, BOOT_SOLE)

# Hair: all over the top and back of the head, the sides but for the cheek in front, bangs and two locks framing
# the face, and long down the back of the dress.
fill(hair, *HEAD['top'], FULL)
fill(hair, *HEAD['back'], SHADE)
x, y, w, h = HEAD['right']          # the right side's front edge is its right column (x 7)
fill(hair, x, y, w, 3, SHADE)
fill(hair, x, y, 5, h, SHADE)
x, y, w, h = HEAD['left']           # the left side's front edge is its left column (x 16)
fill(hair, x, y, w, 3, SHADE)
fill(hair, x + 3, y, 5, h, SHADE)
fill(hair, 8, 8, 8, 2, FULL)        # bangs
for yy in range(10, 16):            # locks framing the face
    hair[yy][8] = FULL
    hair[yy][15] = FULL
hair[10][9] = FULL
hair[10][14] = FULL
fill(hair, 32, 20, 8, 7, SHADE)     # down the back
for xx in range(33, 39):
    hair[27][xx] = SHADE
fill(hair, 16, 20, 1, 4, SHADE)     # over the shoulders, at the sides
fill(hair, 31, 20, 1, 4, SHADE)

OUT.mkdir(parents=True, exist_ok=True)
png(OUT / 'ai_bot_skin.png', skin)
png(OUT / 'ai_bot_dress.png', dress)
png(OUT / 'ai_bot_hair.png', hair)
print('wrote', *(p.name for p in sorted(OUT.glob('ai_bot_*.png'))))

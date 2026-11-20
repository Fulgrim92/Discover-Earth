# tools/sheet.py: contact sheet of shots, 2 columns at half size, labelled. Usage: python3 tools/sheet.py out.png a.png b.png ...
import sys
from PIL import Image, ImageDraw
out, files = sys.argv[1], sys.argv[2:]
ims = [Image.open(f).convert('RGB') for f in files]
w, h = ims[0].size[0] // 2, ims[0].size[1] // 2
cols = 2
rows = (len(ims) + 1) // 2
S = Image.new('RGB', (w * cols, h * rows))
for i, (f, im) in enumerate(zip(files, ims)):
    im = im.resize((w, int(im.size[1] * w / im.size[0])))
    x, y = (i % cols) * w, (i // cols) * h
    S.paste(im, (x, y))
    ImageDraw.Draw(S).text((x + 6, y + 4), f.split('/')[-1], fill=(255, 255, 255))
S.save(out)

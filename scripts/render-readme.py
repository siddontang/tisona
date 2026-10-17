#!/usr/bin/env python3
"""Render the Console's public walkthrough data into small, silent README GIFs."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT, SCALE, FPS, HOLD = 1080, 720, 2, 12, 5
PALETTE = {
    'page': '#101614', 'surface': '#18201c', 'text': '#e5ede7',
    'muted': '#a2b6a9', 'line': '#34453a', 'accent': '#8bd3b1',
    'idle': ('#1c2620', '#34453a', '#a2b6a9'),
    'active': ('#223340', '#4e7289', '#9acbeb'),
    'saved': ('#203a2b', '#426b50', '#8bd3a3'),
    'waiting': ('#352e1f', '#79653b', '#e9c77d'),
    'failed': ('#3a2823', '#815349', '#f0a697'),
}
CLIPS = {
    'tool-retry': ('Retry without losing progress', [
        'Save the plan before calling the tool.',
        'The 429 response becomes recorded progress.',
        'Store a timer; the worker can stop.',
        'Keep the plan. Record the second 429.',
        'Wait again without losing earlier results.',
        'Attempt 3 succeeds. Save and return the result.',
    ]),
    'support-refund': ('Wait for a human. Resume later.', [
        'Load the ticket and check the refund policy.',
        'Save the policy result; wait before issuing a refund.',
        'The worker may stop. The saved wait remains.',
        'Record approval, even while the worker is offline.',
        'Resume the worker. Save the refund and reply.',
    ]),
    'order-saga': ('Recover an order after failure', [
        'Record the inventory reservation.',
        'Save the charge before trying shipment.',
        'Shipping fails after the charge is saved.',
        'Refund the payment as a new, saved action.',
        'Release inventory after the refund.',
        'Keep the failure and both recovery actions inspectable.',
    ]),
}


def fonts():
    candidates = [
        (os.environ.get('TISONA_ANIMATION_FONT'), os.environ.get('TISONA_ANIMATION_BOLD_FONT')),
        ('/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'),
        ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
    ]
    for regular, bold in candidates:
        if regular and Path(regular).is_file():
            return { (size, weight): ImageFont.truetype(bold if weight and bold else regular, size * SCALE)
                     for size in [16, 17, 18, 19, 20, 22, 24, 30, 32, 38]
                     for weight in [False, True] }
    raise SystemExit('Install Arial or DejaVu Sans, or set TISONA_ANIMATION_FONT.')


FONTS = fonts()


def rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def mix(before, after, amount):
    return tuple(round(a + (b - a) * amount) for a, b in zip(rgb(before), rgb(after)))


def bezier(points, t):
    return tuple((1 - t) ** 3 * points[0][i] + 3 * (1 - t) ** 2 * t * points[1][i]
                 + 3 * (1 - t) * t ** 2 * points[2][i] + t ** 3 * points[3][i] for i in (0, 1))


def layout(story):
    if story['layout'] == 'retry':
        return {'plan': (48, 214, 264, 110), 'tool': (408, 214, 264, 110),
                'result': (768, 214, 264, 110), 'wait': (408, 362, 264, 110)}
    return {node['id']: (48 + i * 258, 266, 210, 132) for i, node in enumerate(story['nodes'])}


def edge_points(a, b, backwards):
    x, y, w, h = a; xx, yy, ww, hh = b
    if x == xx:
        bottom, top = (y + h, yy) if y < yy else (y, yy + hh)
        offset = 36 if backwards else 0
        return [(x + w / 2, bottom), (x + w / 2 + offset, (bottom + top) / 2),
                (xx + ww / 2 + offset, (bottom + top) / 2), (xx + ww / 2, top)]
    if backwards:
        return [(x + w / 2, y), (x + w / 2, y - 58), (xx + ww / 2, yy - 58), (xx + ww / 2, yy)]
    return [(x + w, y + h / 2), (x + w + 35, y + h / 2), (xx - 35, yy + hh / 2), (xx, yy + hh / 2)]


def render(story, title, captions, timestamp):
    index = min(int(timestamp / HOLD), len(story['frames']) - 1)
    frame = story['frames'][index]
    previous = story['frames'][max(index - 1, 0)]
    transition = min((timestamp % HOLD) / .35, 1) if index else 1
    transition = transition * transition * (3 - 2 * transition)
    image = Image.new('RGB', (WIDTH * SCALE, HEIGHT * SCALE), PALETTE['page'])
    draw = ImageDraw.Draw(image)

    def text(x, y, value, size=20, color=None, bold=False):
        draw.text((x * SCALE, y * SCALE), value, font=FONTS[size, bold], fill=color or PALETTE['text'])

    def wrapped(value, size, width, bold=False):
        rows, line = [], ''
        for word in value.split():
            candidate = (line + ' ' + word).strip()
            if draw.textlength(candidate, font=FONTS[size, bold]) > width * SCALE and line:
                rows.append(line); line = word
            else: line = candidate
        return rows + ([line] if line else [])

    def line(points, fill, width=2):
        draw.line([(int(x * SCALE), int(y * SCALE)) for x, y in points], fill=fill, width=width * SCALE, joint='curve')

    def box(x, y, w, h, fill, outline=None, radius=12):
        draw.rounded_rectangle((x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE),
                               radius=radius * SCALE, fill=fill, outline=outline, width=SCALE)

    text(48, 31, 'TiSona', 24, PALETTE['accent'], True)
    text(153, 38, 'DURABLE EXECUTION', 16, PALETTE['muted'])
    text(836, 38, 'ILLUSTRATED PREVIEW', 16, PALETTE['muted'])
    line([(48, 78), (1032, 78)], PALETTE['line'], 1)
    text(48, 103, title, 38, bold=True)
    text(48, 158, story['title'], 20, PALETTE['muted'])
    text(932, 161, f'{index + 1} / {len(story["frames"])}', 18, PALETTE['muted'])
    positions = layout(story)
    order = [node['id'] for node in story['nodes']]
    for i, (source, target) in enumerate(story['edges']):
        backwards = order.index(source) > order.index(target)
        active = i in frame['activeEdges']; saved = i in frame['doneEdges']
        if backwards and not active and not saved: continue
        color = PALETTE['active'][2] if active else PALETTE['saved'][2] if saved else PALETTE['line']
        points = edge_points(positions[source], positions[target], backwards)
        curve = [bezier(points, j / 60) for j in range(61)]
        line(curve, color)
        tip = curve[-1]; angle = math.atan2(tip[1] - curve[-2][1], tip[0] - curve[-2][0])
        line([(tip[0] - 8 * math.cos(angle - .5), tip[1] - 8 * math.sin(angle - .5)), tip,
              (tip[0] - 8 * math.cos(angle + .5), tip[1] - 8 * math.sin(angle + .5))], color)
        if active:
            px, py = bezier(points, (timestamp / 1.8) % 1)
            draw.ellipse(((px - 4) * SCALE, (py - 4) * SCALE, (px + 4) * SCALE, (py + 4) * SCALE), fill=color)
    for node in story['nodes']:
        key = node['id']; x, y, w, h = positions[key]
        value = frame['nodes'].get(key, {'status': 'idle', 'text': 'Not started'})
        old = previous['nodes'].get(key, {'status': 'idle'})
        colors, old_colors = PALETTE[value['status']], PALETTE[old['status']]
        box(x, y, w, h, mix(old_colors[0], colors[0], transition), mix(old_colors[1], colors[1], transition))
        labels = wrapped(node['label'], 22, w - 56, True)
        details = wrapped(value['text'], 18, w - 32)
        assert len(labels) * 26 + len(details) * 22 + 32 <= h, f'Node text overflows: {key}'
        for j, row in enumerate(labels): text(x + 16, y + 14 + j * 26, row, 22, bold=True)
        for j, row in enumerate(details): text(x + 16, y + 21 + len(labels) * 26 + j * 22, row, 18, colors[2])
        sx, sy = x + w - 25, y + 23
        if value['status'] == 'saved': line([(sx - 6, sy), (sx - 1, sy + 5), (sx + 7, sy - 7)], colors[2])
        elif value['status'] == 'failed':
            line([(sx - 5, sy - 5), (sx + 5, sy + 5)], colors[2]); line([(sx + 5, sy - 5), (sx - 5, sy + 5)], colors[2])
        elif value['status'] == 'waiting':
            line([(sx - 3, sy - 5), (sx - 3, sy + 5)], colors[2]); line([(sx + 3, sy - 5), (sx + 3, sy + 5)], colors[2])
        else: draw.ellipse(((sx - 3) * SCALE, (sy - 3) * SCALE, (sx + 3) * SCALE, (sy + 3) * SCALE), fill=colors[2])
    box(48, 491, 984, 43, PALETTE['surface'], PALETTE['line'], 8)
    text(61, 504, 'Saved progress', 16, PALETTE['muted'])
    cursor = 185
    for item in frame['saved']:
        item = '1 failure recorded' if item == '1 failures recorded' else item
        width = draw.textlength(item, font=FONTS[17, False]) / SCALE + 22
        assert cursor + width < 1020, 'Checkpoint ledger overflows'
        box(cursor, 499, width, 27, PALETTE['saved'][0], radius=5)
        text(cursor + 11, 503, item, 17, PALETTE['saved'][2]); cursor += width + 9
    text(48, 555, frame['title'], 30, bold=True)
    rows = wrapped(captions[index], 22, 984)
    assert len(rows) <= 2, 'Caption overflows'
    for i, row in enumerate(rows): text(48, 602 + i * 28, row, 22, PALETTE['muted'])
    for i, (status, label) in enumerate([('active', 'Running'), ('saved', 'Saved'), ('waiting', 'Waiting'), ('failed', 'Failed')]):
        x = 48 + i * 116
        draw.ellipse((x * SCALE, 677 * SCALE, (x + 6) * SCALE, 683 * SCALE), fill=PALETTE[status][2])
        text(x + 14, 670, label, 16, PALETTE[status][2])
    text(663, 670, 'Simulated tools · Resonate + TiDB', 18, PALETTE['muted'])
    draw.rectangle((0, 716 * SCALE, WIDTH * SCALE, HEIGHT * SCALE), fill=PALETTE['line'])
    progress = timestamp / (len(story['frames']) * HOLD)
    draw.rectangle((0, 716 * SCALE, int(WIDTH * SCALE * progress), HEIGHT * SCALE), fill=PALETTE['accent'])
    return image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stills', action='store_true', help='Only generate stage posters for review')
    args = parser.parse_args()
    source = "import {exampleStory} from './web/walkthrough-data.js'; console.log(JSON.stringify(%s.map(id=>exampleStory(id))))" % json.dumps(list(CLIPS))
    stories = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', source], cwd=ROOT))
    work = ROOT / '.local/readme-animations'; work.mkdir(parents=True, exist_ok=True)
    output = ROOT / 'docs/animations'; output.mkdir(parents=True, exist_ok=True)
    for story in stories:
        name = story['id']; title, captions = CLIPS[name]
        assert len(captions) == len(story['frames']), 'Console story changed; update the compact captions'
        for i in range(len(captions)):
            render(story, title, captions, i * HOLD + 1).save(work / f'{name}-stage-{i + 1}.png')
        # Random-access rendering must not depend on a previously rendered frame.
        checks = [len(captions) * HOLD - .5, 1.25, HOLD + .15]
        before = [hashlib.sha256(render(story, title, captions, t).tobytes()).digest() for t in checks]
        after = {t: hashlib.sha256(render(story, title, captions, t).tobytes()).digest() for t in reversed(checks)}
        assert all(a == after[t] for a, t in zip(before, checks)), 'Nondeterministic animation'
        if args.stills:
            print(f'{name}: {len(captions)} stage posters; deterministic frames verified', flush=True); continue
        frames = work / name; frames.mkdir(exist_ok=True)
        for i in range(len(captions) * HOLD * FPS):
            render(story, title, captions, i / FPS).save(frames / f'{i:04d}.png')
        subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-framerate', str(FPS), '-i', str(frames / '%04d.png'),
                        '-filter_complex', 'split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
                        '-loop', '0', str(output / f'{name}.gif')], check=True)
        with Image.open(output / f'{name}.gif') as gif:
            assert gif.n_frames == len(captions) * HOLD * FPS and gif.info.get('loop') == 0
        print(f'{name}: {len(captions) * HOLD}s, {FPS}fps, {(output / (name + ".gif")).stat().st_size // 1024} KiB', flush=True)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""App 标识图标生成器 —— 唯一出处,❌ 手工导出。

    uv run --with pillow --with numpy python scripts/gen-app-icons.py
    uv run --with pillow --with numpy python scripts/gen-app-icons.py --check   # 只比对,不写(CI 用)

管的是**咕咕这个应用自己的图标**(Dock / 任务栏 / 桌面 / 启动器上那一个),不是界面里的图标库
(那是 Solar,见 scripts/gen-icons.mjs),也不是菜单栏托盘图(那是 scripts/gen-tray-icons.py)。

源图 build-resources/icon-sources/app-icon-source-1024.png:owner 2026-09-18 选定的大头特写(候选原图
留在同目录 app-icon-original-d1.png)。产物:

  · macOS  build-resources/AppIcon.icon/      —— Icon Composer 三态包(浅色/深色/着色)。底色走
           icon.json 的 fill-specializations,图层只留主体、背景必须透明,否则深色态会被糊死。
           ⚠ `X-specializations` 数组不能与同名基础键 `X` 并存,并存时 actool **静默忽略**
           覆盖,包照样编得过、三态却没了 —— 所以这里只写 fill-specializations,不写 fill。
           ⚠ 出 mac 包的机器要 Xcode 26+(electron-builder 会先跑 `actool --version` 卡版本)。
  · macOS  build-resources/icon.icns          —— 传统格式 10 档。满幅自带圆角,❌ 别用经典的 824/1024
           安全区:线上那份就是满幅,缩到 80% 会在 Dock 里比邻居小一圈。
           ⚠ 这份必须靠 electron-builder.cjs 的 afterPack 手动盖进包里:`mac.icon` 指向
           `.icon` 之后,electron-builder 改用 actool 现派生一份 icns,而那份**只有 16/128
           两档**,macOS 25 及更早会拿 256px 往上拉。
  · Windows build-resources/icon.ico          —— 9 档 16/20/24/32/40/48/64/128/256。
  · Linux   public/assets/app/gugu-icon-512.png —— AppImage 主图;同一张也是设置页/关于页
           显示的应用图标与默认头像(有 supabase 迁移与 e2e 钉着路径,❌ 别改文件名)。
  · Android apps/mobile/android/app/src/main/res/ —— 自适应图标三层 × 五档密度:
           ic_launcher_foreground(彩色)、**ic_launcher_monochrome(Android 13+ 主题图标,
           系统只取 alpha 自己着色)**、以及 Android 7 及更早认的 ic_launcher / _round 方圆图。
           几何按规范:画布 108dp,遮罩后可见 72dp,保证安全区 66dp —— 素材一律落进 66/108,
           ❌ 别按可见区 72/108 放:圆形遮罩还要再吃掉四角,实测 0.82 会切掉一只眼睛和腮红。
           主题层复用单色标 build-resources/icon-sources/tray-mark-source.png,与托盘图同源。
"""
from __future__ import annotations
import hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'build-resources' / 'icon-sources' / 'app-icon-source-1024.png'
MONO_SRC = ROOT / 'build-resources' / 'icon-sources' / 'tray-mark-source.png'
PACKAGING = ROOT / 'build-resources'
PUBLIC = ROOT / 'public'
ANDROID_RES = ROOT / 'apps' / 'mobile' / 'android' / 'app' / 'src' / 'main' / 'res'

MINT = (143, 212, 180)          # 浅色底,取自源图
MINT_DARK = (45, 76, 64)        # 深色底:同色相压暗,❌ 别换色相
ICNS_SIZES = [16, 32, 128, 256, 512]
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
# mdpi 1× / hdpi 1.5× / xhdpi 2× / xxhdpi 3× / xxxhdpi 4×
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
ADAPTIVE_CANVAS_DP = 108
ADAPTIVE_SAFE_DP = 66           # 保证安全区,所有遮罩形状下都完整
LEGACY_DP = 48

CHECK = '--check' in sys.argv
_writes: list[tuple[Path, bytes]] = []


def emit(path: Path, data: bytes) -> None:
    _writes.append((path, data))


def emit_image(path: Path, img: Image.Image, **kw) -> None:
    import io
    buf = io.BytesIO()
    img.save(buf, format=kw.pop('format', 'PNG'), **kw)
    emit(path, buf.getvalue())


def squircle(size: int, radius_ratio: float = 0.2237, ss: int = 8) -> Image.Image:
    """Apple 连续圆角的近似:超采样画圆角矩形再缩回,边缘不毛。"""
    n = size * ss
    m = Image.new('L', (n, n), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * radius_ratio), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def circle(size: int, ss: int = 8) -> Image.Image:
    n = size * ss
    m = Image.new('L', (n, n), 0)
    ImageDraw.Draw(m).ellipse([0, 0, n - 1, n - 1], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def rounded(src: Image.Image, size: int) -> Image.Image:
    im = src.convert('RGB').resize((size, size), Image.LANCZOS).convert('RGBA')
    im.putalpha(squircle(size))
    return im


def load_mono_alpha() -> Image.Image:
    """单色标 → alpha 方图,带 1/8 内边距(主题图标被系统裁得比彩色图更狠,不留白会顶格)。"""
    g = Image.open(MONO_SRC).convert('L')
    a = ImageOps.invert(g).point(lambda v: 0 if v < 40 else (255 if v > 215 else v))
    bb = a.getbbox()
    if not bb:
        raise SystemExit(f'单色标里没有暗像素: {MONO_SRC}')
    a = a.crop(bb)
    w, h = a.size
    s = max(w, h)
    sq = Image.new('L', (s, s), 0)
    sq.paste(a, ((s - w) // 2, (s - h) // 2))
    return ImageOps.expand(sq, s // 8, 0)


def adaptive_layer(src: Image.Image, canvas_px: int, content_dp: int) -> Image.Image:
    n = int(round(canvas_px * content_dp / ADAPTIVE_CANVAS_DP))
    im = src.resize((n, n), Image.LANCZOS)
    c = Image.new('RGBA', (canvas_px, canvas_px), (0, 0, 0, 0))
    o = (canvas_px - n) // 2
    c.paste(im, (o, o), im)
    return c


def srgb(rgb: tuple[int, int, int]) -> str:
    return 'extended-srgb:' + ','.join(f'{c / 255:.5f}' for c in rgb) + ',1.00000'


def build() -> None:
    full = Image.open(SRC).convert('RGB')
    if full.size != (1024, 1024):
        raise SystemExit(f'源图必须是 1024×1024,实际 {full.size}')

    # --- macOS 三态包 ---
    import numpy as np
    a = np.asarray(full).astype(int)
    dist = np.abs(a - np.array(MINT)).sum(axis=2)
    # 软 alpha:距离 24 以内算纯底色,64 以外算纯主体,中间线性过渡,保住描边的抗锯齿
    alpha = np.clip((dist - 24) / 40, 0, 1)
    layer = Image.fromarray(np.dstack([a.astype(np.uint8), (alpha * 255).astype(np.uint8)]), 'RGBA')
    emit_image(PACKAGING / 'AppIcon.icon' / 'Assets' / 'gugu.png', layer)
    emit(PACKAGING / 'AppIcon.icon' / 'icon.json', (json.dumps({
        'fill-specializations': [
            {'value': {'solid': srgb(MINT)}},
            {'appearance': 'dark', 'value': {'solid': srgb(MINT_DARK)}},
        ],
        'groups': [{
            'layers': [{'image-name': 'gugu.png', 'name': 'gugu'}],
            'shadow': {'kind': 'neutral', 'opacity': 0.35},
        }],
        'supported-platforms': {'squares': 'shared'},
    }, indent=2) + '\n').encode())

    # --- macOS 传统 icns ---
    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / 'gugu.iconset'
        iconset.mkdir()
        for base in ICNS_SIZES:
            rounded(full, base).save(iconset / f'icon_{base}x{base}.png')
            rounded(full, base * 2).save(iconset / f'icon_{base}x{base}@2x.png')
        out = Path(td) / 'icon.icns'
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(out)], check=True)
        emit(PACKAGING / 'icon.icns', out.read_bytes())

    # --- Windows ico ---
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / 'icon.ico'
        rounded(full, max(ICO_SIZES)).save(p, format='ICO', sizes=[(s, s) for s in ICO_SIZES])
        got = sorted(Image.open(p).info.get('sizes', []))
        # Pillow 的 sizes= 会静默降级 —— 曾经出过「只有一个 16×16、828 字节」的 ico,必须当场断言
        if got != sorted([(s, s) for s in ICO_SIZES]):
            raise SystemExit(f'ico 尺寸不全: {[s[0] for s in got]}')
        emit(PACKAGING / 'icon.ico', p.read_bytes())

    # --- Linux / 设置页 / 默认头像 ---
    emit_image(PUBLIC / 'assets' / 'app' / 'gugu-icon-512.png', rounded(full, 512))

    # --- Android ---
    fg = full.convert('RGBA')
    mono_sq = load_mono_alpha()
    mono = Image.new('RGBA', mono_sq.size, (0, 0, 0, 0))
    mono.putalpha(mono_sq)
    for name, mult in DENSITIES.items():
        d = ANDROID_RES / f'mipmap-{name}'
        canvas = int(round(ADAPTIVE_CANVAS_DP * mult))
        emit_image(d / 'ic_launcher_foreground.png', adaptive_layer(fg, canvas, ADAPTIVE_SAFE_DP))
        emit_image(d / 'ic_launcher_monochrome.png', adaptive_layer(mono, canvas, ADAPTIVE_SAFE_DP))
        px = int(round(LEGACY_DP * mult))
        base = full.resize((px, px), Image.LANCZOS).convert('RGBA')
        sq = base.copy(); sq.putalpha(squircle(px))
        emit_image(d / 'ic_launcher.png', sq)
        ci = base.copy(); ci.putalpha(circle(px))
        emit_image(d / 'ic_launcher_round.png', ci)

    adaptive_xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n'
        '</adaptive-icon>\n'
    )
    for f in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        emit(ANDROID_RES / 'mipmap-anydpi-v26' / f, adaptive_xml.encode())
    emit(ANDROID_RES / 'values' / 'ic_launcher_background.xml',
         ('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
          f'    <color name="ic_launcher_background">#{MINT[0]:02X}{MINT[1]:02X}{MINT[2]:02X}</color>\n'
          '</resources>\n').encode())


def main() -> int:
    build()
    stale = []
    for path, data in _writes:
        old = path.read_bytes() if path.exists() else None
        if old == data:
            continue
        if CHECK:
            stale.append(path.relative_to(ROOT))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    if CHECK:
        if stale:
            print('以下产物与源图对不上,跑 `python scripts/gen-app-icons.py` 重生:', file=sys.stderr)
            for p in stale:
                print(f'  {p}', file=sys.stderr)
            return 1
        print(f'gen-app-icons: {len(_writes)} 个产物均与源图一致')
    else:
        print(f'gen-app-icons: 写入 {len(_writes)} 个产物')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

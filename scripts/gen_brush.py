#!/usr/bin/env python3
"""
生成毛笔笔触纹理（干笔飞白 / 边缘毛糙 / 两端收锋），输出为可直接当 mask 用的 SVG 数据。

用法：python3 scripts/gen_brush.py
产物：src/styles/brush.css —— 内含 --brush-stroke-1/2/3 与 --brush-wash-1/2 五个遮罩变量。

为什么不用手画路径：真正的毛笔边缘是「随机啃噬 + 高頻毛刺」，手工路径写不出这种质感，
所以这里用带种子的噪声程序化生成 —— 每次运行结果完全一致，可复现。
"""

import math
import random

OUT = "src/styles/brush.css"


def stroke(seed, w=420, h=110, points=132, holes=54, specks=10):
    rnd = random.Random(seed)
    phase = rnd.uniform(0, 6.28)

    def half(t):
        """笔锋宽度包络：两端收细，中段最饱满，并带一点不对称"""
        return (math.sin(math.pi * t) ** 0.62) * (1 + 0.16 * math.sin(t * 5.3 + phase))

    def centerline(t):
        """中轴线的低频摆动，让笔触不是一条死板的直杆"""
        return h * 0.5 + 3.6 * math.sin(t * 6.1 + phase) + 2.2 * math.sin(t * 13.7 + phase * 1.9)

    top, bot = [], []
    for i in range(points + 1):
        t = i / points
        x = t * w
        hw = half(t) * h * 0.33
        cy = centerline(t)
        # 高频毛刺 + 偶发的「啃边」
        f_top = rnd.uniform(-1.5, 1.5)
        f_bot = rnd.uniform(-1.5, 1.5)
        if rnd.random() < 0.10:
            f_top -= rnd.uniform(2.5, 8.5)
        if rnd.random() < 0.10:
            f_bot += rnd.uniform(2.5, 8.5)
        if 0.02 < t < 0.98:
            top.append((x, cy - hw + f_top))
            bot.append((x, cy + hw + f_bot))

    def poly(pts):
        return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"

    body = poly(top) + " " + poly(list(reversed(bot)))

    # 飞白：笔腹里的不规则枯笔空洞
    hole_paths = []
    for _ in range(holes):
        t = rnd.random()
        hw = half(t) * h * 0.33
        cy = centerline(t)
        y = cy + rnd.uniform(-hw * 0.78, hw * 0.78)
        r = rnd.uniform(0.9, 3.6) * (1.35 - abs(t - 0.5))
        if r < 0.7 or hw < 1.2:
            continue
        pts = []
        for k in range(7):
            a = k / 7 * math.tau
            rr = r * rnd.uniform(0.55, 1.5)
            pts.append((t * w + math.cos(a) * rr * 1.7, y + math.sin(a) * rr))
        hole_paths.append(poly(pts))

    body_plus_holes = body + (" " + " ".join(hole_paths) if hole_paths else "")

    # 笔触之外的飞溅墨点（收笔时甩出去的）
    drops = []
    for _ in range(specks):
        side = rnd.choice([0, 1])
        t = rnd.uniform(0.0, 0.16) if side == 0 else rnd.uniform(0.84, 1.0)
        x = t * w + rnd.uniform(-14, 14)
        y = centerline(t) + rnd.uniform(-1, 1) * h * 0.42
        r = rnd.uniform(0.9, 3.2)
        drops.append(
            f"M{x:.1f},{y:.1f} m-{r:.1f},0 a{r:.1f},{r * 0.75:.1f} 0 1,0 {r * 2:.1f},0 "
            f"a{r:.1f},{r * 0.75:.1f} 0 1,0 -{r * 2:.1f},0 Z"
        )

    # 两层：外圈半透明的羽化层 + 实心主体
    feathered = poly(top) + " " + poly(list(reversed(bot)))
    return (
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' preserveAspectRatio='none'>"
        f"<g fill='#000'>"
        f"<g opacity='.34' transform='translate(0,-1.6) scale(1,1.06)' transform-origin='{w / 2} {h / 2}'>"
        f"<path d='{feathered}'/></g>"
        f"<path fill-rule='evenodd' d='{body_plus_holes}'/>"
        f"{''.join(f'<path d=\"{d}\"/>' for d in drops)}"
        f"</g></svg>"
    )


def wash(seed, w=420, h=260, points=96, holes=70):
    """大块墨晕：用于卡片这类大面积，形状更松更方"""
    rnd = random.Random(seed)
    phase = rnd.uniform(0, 6.28)
    top, bot = [], []
    for i in range(points + 1):
        t = i / points
        x = t * w
        # 上下左右都留出收边，避免像一块规整的矩形
        env = (math.sin(math.pi * t) ** 0.35) * (1 + 0.1 * math.sin(t * 4.4 + phase))
        top.append((x, h * 0.5 - env * h * 0.42 + rnd.uniform(-3.2, 3.2)))
        bot.append((x, h * 0.5 + env * h * 0.42 + rnd.uniform(-3.2, 3.2)))

    def poly(pts):
        return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"

    body = poly(top) + " " + poly(list(reversed(bot)))
    hole_paths = []
    for _ in range(holes):
        t = rnd.uniform(0.05, 0.95)
        env = (math.sin(math.pi * t) ** 0.35) * h * 0.42
        if env < 6:
            continue
        y = h * 0.5 + rnd.uniform(-env * 0.82, env * 0.82)
        r = rnd.uniform(1.6, 6.5)
        pts = []
        for k in range(8):
            a = k / 8 * math.tau
            rr = r * rnd.uniform(0.5, 1.6)
            pts.append((t * w + math.cos(a) * rr * 1.5, y + math.sin(a) * rr))
        hole_paths.append(poly(pts))
    return (
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' preserveAspectRatio='none'>"
        f"<g fill='#000'><g opacity='.32' transform='translate(0,-3) scale(1,1.08)' "
        f"transform-origin='{w / 2} {h / 2}'><path d='{body}'/></g>"
        f"<path fill-rule='evenodd' d='{body + ' ' + ' '.join(hole_paths)}'/></g></svg>"
    )


def data_uri(svg: str) -> str:
    enc = (
        svg.replace("%", "%25")
        .replace("<", "%3C")
        .replace(">", "%3E")
        .replace("#", "%23")
        .replace('"', "'")
        .replace("\n", "")
    )
    return f'url("data:image/svg+xml,{enc}")'


def main():
    lines = [
        "/* ==========================================================================",
        "   毛笔笔触遮罩 —— 由 scripts/gen_brush.py 程序化生成，请勿手工修改",
        "   质感：干笔飞白（枯笔空洞）· 边缘毛糙（高频啃噬）· 两端收锋",
        "   ========================================================================== */",
        "",
        ":root {",
    ]
    for i, seed in enumerate((11, 27, 43), start=1):
        lines.append(f"  --brush-stroke-{i}: {data_uri(stroke(seed))};")
    for i, seed in enumerate((101, 137), start=1):
        lines.append(f"  --brush-wash-{i}: {data_uri(wash(seed))};")
    lines += [
        "  /* 组件默认取第 1 号笔触与第 1 号墨晕 */",
        "  --brush-mask: var(--brush-stroke-1);",
        "  --brush-mask-lg: var(--brush-wash-1);",
        "}",
        "",
    ]
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"已生成 {OUT}（{sum(len(l) for l in lines) // 1024} KB）")


if __name__ == "__main__":
    main()

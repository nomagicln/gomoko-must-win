/** Browser-side audit. Import through Vite and run auditDesign() after the view settles. */
export function auditDesign() {
  const pixel = document.createElement('canvas');
  pixel.width = pixel.height = 1;
  const ctx = pixel.getContext('2d', { willReadFrequently: true });
  const rgba = color => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].map((n, i) => i === 3 ? n / 255 : n);
  };
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    return [0, 1, 2].map(i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / (a || 1)).concat(a);
  };
  const luminance = c => c.slice(0, 3).map(n => {
    n /= 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const aa = luminance(a), bb = luminance(b);
    return (Math.max(aa, bb) + 0.05) / (Math.min(aa, bb) + 0.05);
  };
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const token = name => rgba(style.getPropertyValue(name).trim());
  const roles = [];
  for (const bg of ['--bg', '--bg-panel', '--bg-elevated', '--bg-sunk']) {
    for (const fg of ['--text-strong', '--text', '--text-dim', '--text-faint']) {
      roles.push({ fg, bg, ratio: +ratio(token(fg), token(bg)).toFixed(2), threshold: 4.5 });
    }
    roles.push({ fg: '--border', bg, ratio: +ratio(token('--border'), token(bg)).toFixed(2), threshold: 3 });
    roles.push({ fg: '--focus', bg, ratio: +ratio(token('--focus'), token(bg)).toFixed(2), threshold: 3 });
  }
  roles.push({ fg: '--on-accent', bg: '--accent', ratio: +ratio(token('--on-accent'), token('--accent')).toFixed(2), threshold: 4.5 });
  const failures = [];
  let checked = 0;
  for (const element of document.querySelectorAll('#app *, .toast *, .modal *')) {
    const text = [...element.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent.trim()).join('');
    if (!text || element.closest('[hidden], :disabled, [aria-hidden="true"]')) continue;
    const rect = element.getBoundingClientRect();
    const s = getComputedStyle(element);
    if (!rect.width || !rect.height || s.visibility === 'hidden') continue;
    let bg = [0, 0, 0, 0];
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) {
      const st = getComputedStyle(node);
      bg = over(bg, rgba(st.backgroundColor));
      // 主按钮的实色文字衬底由 ::after 的不规则墨面绘制。
      if (node.matches('.btn--primary')) bg = over(bg, token('--accent'));
      opacity *= Number(st.opacity);
    }
    // Transitional elements are audited in their settled state.
    if (opacity < 0.9) continue;
    bg = over(bg, token('--bg'));
    const fg = rgba(s.color);
    fg[3] *= opacity;
    const actual = ratio(over(fg, bg), bg);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const threshold = large ? 3 : 4.5;
    checked++;
    if (actual + 0.02 < threshold) failures.push({ text: text.slice(0, 60), selector: `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`, ratio: +actual.toFixed(2), threshold, fg: s.color, bg });
  }
  const overflow = root.scrollWidth > innerWidth;
  return { theme: root.dataset.theme, route: location.hash, viewport: [innerWidth, innerHeight], checked,
    minTextRoleContrast: Math.min(...roles.filter(r => r.threshold === 4.5).map(r => r.ratio)),
    tokenFailures: roles.filter(r => r.ratio < r.threshold), failures, overflow, roles };
}

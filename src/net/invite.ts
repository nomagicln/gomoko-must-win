import { normalizeCode } from './peer';

/** 所有分享入口共用一条链接，保留项目子路径。开发时用局域网地址替换本机地址。 */
export function invitationURL(code: string, pageURL: string, lanHost = ''): string {
  const url = new URL(pageURL);
  if (lanHost && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = lanHost;
  url.search = '';
  url.hash = `/online?r=${encodeURIComponent(normalizeCode(code))}`;
  return url.href;
}

export async function renderInviteQR(canvas: HTMLCanvasElement, url: string): Promise<void> {
  const { default: QRCode } = await import('qrcode');
  await QRCode.toCanvas(canvas, url, {
    width: 256, margin: 4, errorCorrectionLevel: 'M',
    color: { dark: '#171714', light: '#ffffff' },
  });
}

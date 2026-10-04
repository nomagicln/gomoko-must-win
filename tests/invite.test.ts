import { describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { invitationURL, renderInviteQR } from '../src/net/invite';
import { randomNickname } from '../src/net/nickname';

describe('邀请地址与二维码', () => {
  it('保留项目路径、清除旧查询，并使用目标房间', () => {
    const url = invitationURL('ab-c23', 'https://example.com/gomoko-must-win/?old=1#/online?r=OLD');
    expect(url).toBe('https://example.com/gomoko-must-win/#/online?r=ABC23');
  });
  it('本机开发邀请改用局域网，线上邀请保持原来的域名', () => {
    expect(invitationURL('ABC23', 'http://localhost:5173/gomoko-must-win/', '192.168.1.9'))
      .toBe('http://192.168.1.9:5173/gomoko-must-win/#/online?r=ABC23');
    expect(invitationURL('ABC23', 'https://example.com/gomoko-must-win/', '192.168.1.9'))
      .toBe('https://example.com/gomoko-must-win/#/online?r=ABC23');
  });
  it('真实解码生成的二维码像素后得到同一条邀请链接', async () => {
    const url = invitationURL('ABC23', 'https://example.com/gomoko-must-win/');
    let pixels: Uint8ClampedArray = new Uint8ClampedArray();
    const canvas = {
      width: 0, height: 0, style: {},
      getContext: () => ({
        createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        clearRect: () => {},
        putImageData: (image: { data: Uint8ClampedArray }) => { pixels = image.data; },
      }),
    } as unknown as HTMLCanvasElement;
    await renderInviteQR(canvas, url);
    expect(canvas.width).toBe(256);
    expect(jsQR(pixels, canvas.width, canvas.height)?.data).toBe(url);
    expect([...pixels.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });
});

describe('随机昵称', () => {
  it('生成适合昵称输入框的水墨名字，随机值变化时名字随之变化', () => {
    let count = 0;
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      (array as Uint32Array).set([count, count++]);
      return array;
    });
    const a = randomNickname(), b = randomNickname();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\u4e00-\u9fff]{3,4}$/);
    expect(a.length).toBeLessThanOrEqual(12);
    spy.mockRestore();
  });
});

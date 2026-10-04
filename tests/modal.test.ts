// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { modal } from '../src/ui/dom';
afterEach(() => document.body.replaceChildren());
it('确认操作关闭弹窗并恢复焦点，重复关闭只通知一次', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const onClick = vi.fn(), onClose = vi.fn();
  const close = modal({ title: '重新开局？', body: [], onClose, actions: [{ label: '重新开局', onClick }] });
  document.querySelector<HTMLButtonElement>('.modal__actions button')!.click();
  expect(document.querySelector('.modal')).toBeNull(); expect(onClick).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(opener);
  close(); expect(onClose).toHaveBeenCalledOnce();
});
it('取消不执行确认动作，也能正常关闭', () => {
  const confirm = vi.fn();
  modal({ title: '重新开局？', body: [], actions: [{ label: '取消', onClick: () => {} }, { label: '重新开局', onClick: confirm }] });
  document.querySelector<HTMLButtonElement>('.modal__actions button')!.click();
  expect(document.querySelector('.modal')).toBeNull(); expect(confirm).not.toHaveBeenCalled();
});

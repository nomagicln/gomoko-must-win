const SURNAMES = ['慕容', '司徒', '南宫', '东方', '独孤', '上官', '令狐', '轩辕', '百里', '云', '沈', '顾', '陆', '萧', '苏', '叶', '洛', '楚', '温', '宁'];
const NAMES = ['听雪', '青岚', '无尘', '凌霄', '长风', '惊鸿', '沧澜', '云舟', '疏影', '忘川', '照夜', '清欢', '寒江', '逐月', '问剑', '怀瑾', '天阙', '飞羽', '玄霜', '星河', '九歌', '若虚', '听雨', '望舒'];

/** 每次入座随机取一个不带数字的江湖名字，仍可在大厅自行改名。 */
export function randomNickname(previous = ''): string {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  const surname = SURNAMES[values[0] % SURNAMES.length];
  let index = values[1] % NAMES.length;
  if (`${surname}${NAMES[index]}` === previous) index = (index + 1) % NAMES.length;
  return `${surname}${NAMES[index]}`;
}

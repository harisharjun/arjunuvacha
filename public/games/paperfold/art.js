// The pictures, drawn in one ink. Each is laid out in the finished sheet's own
// units (one square is 1×1), so a square of paper shows exactly its part.
export const INK = '#24323D';

const ICONS = {
  circle: '<circle cx="50" cy="50" r="42"/>',
  diamond: '<path d="M50 4 92 50 50 96 8 50Z"/>',
  heart: '<path d="M50 90C12 62 4 44 8 28 13 10 38 8 50 28 62 8 87 10 92 28 96 44 88 62 50 90Z"/>',
  star: '<path d="M50 4 63 36 97 38 70 60 80 94 50 75 20 94 30 60 3 38 37 36Z"/>',
  moon: '<path d="M64 6A46 46 0 1 0 94 68 38 38 0 0 1 64 6Z"/>',
  sun: `<circle cx="50" cy="50" r="24"/><path stroke="${INK}" stroke-width="8" stroke-linecap="round" d="M50 6V16M50 84V94M6 50H16M84 50H94M19 19 26 26M74 74 81 81M19 81 26 74M74 26 81 19"/>`,
  boat: '<path d="M46 8V62H12ZM54 18 86 62H54ZM6 68H94L78 90H22Z"/>',
  hills: '<circle cx="72" cy="26" r="14"/><path d="M0 90C14 56 34 48 50 66 62 52 84 48 100 90Z"/>',
  mountain: '<path d="M2 90 36 26 52 54 66 34 98 90Z"/><circle cx="82" cy="18" r="9"/>',
  fish: '<path d="M6 50C22 22 58 22 74 50 58 78 22 78 6 50ZM70 50 96 26V74Z"/>',
  whale: `<path d="M6 58C6 36 34 30 54 42 66 50 76 44 82 30L96 22 92 44C88 66 70 78 46 78 24 78 6 74 6 58Z"/><path d="M30 18V30M22 14 30 20 38 14" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`,
  bird: '<path d="M8 66C24 34 40 30 50 50 56 30 74 20 94 24 80 40 70 66 44 76 30 80 18 76 8 66Z"/>',
  house: '<path d="M50 8 94 46H82V92H58V64H42V92H18V46H6Z"/>',
  tree: '<path d="M50 4 80 42H66L88 72H56V96H44V72H12L34 42H20Z"/>',
  lighthouse: '<path d="M42 4H58V14H64V24H36V14H42ZM38 28H62L72 96H28Z"/>',
  rocket: '<path d="M50 2C66 16 70 36 68 62H32C30 36 34 16 50 2ZM32 56 16 80 32 76ZM68 56 84 80 68 76ZM40 68H60L54 96H46Z"/>',
  flower: `<circle cx="50" cy="30" r="15"/><circle cx="31" cy="44" r="15"/><circle cx="69" cy="44" r="15"/><circle cx="38" cy="62" r="13"/><circle cx="62" cy="62" r="13"/><path d="M50 60V98" stroke="${INK}" stroke-width="6" fill="none"/>`,
  anchor: `<path d="M50 28V90M28 46H72" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/><circle cx="50" cy="16" r="10" fill="none" stroke="${INK}" stroke-width="7"/><path d="M12 56C14 80 32 92 50 92 68 92 86 80 88 56" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>`,
  umbrella: `<path d="M6 52C10 24 28 10 50 10 72 10 90 24 94 52Z"/><path d="M50 52V84C50 96 34 96 32 84" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`,
  cup: `<path d="M12 22H72V62C72 78 60 88 42 88 24 88 12 78 12 62Z"/><path d="M72 32H82C94 32 94 60 82 60H72" fill="none" stroke="${INK}" stroke-width="8"/>`,
  key: `<circle cx="50" cy="22" r="18" fill="none" stroke="${INK}" stroke-width="10"/><path d="M50 40V94M50 66H68M50 84H68" fill="none" stroke="${INK}" stroke-width="10"/>`,
  leaf: `<path d="M86 8C40 8 12 34 14 74 54 78 86 52 86 8Z"/><path d="M6 94C22 70 40 52 62 34" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`,
  crown: '<path d="M8 28 30 52 50 16 70 52 92 28 84 80H16Z"/>',
  bell: `<path d="M50 8C28 8 22 28 22 48 22 64 12 70 10 78H90C88 70 78 64 78 48 78 28 72 8 50 8Z"/><circle cx="50" cy="88" r="9"/>`,
  apple: `<path d="M50 30C32 16 10 26 10 52 10 78 30 96 42 94 46 93 54 93 58 94 70 96 90 78 90 52 90 26 68 16 50 30Z"/><path d="M50 28C50 16 56 8 68 6" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`,
  mushroom: '<path d="M6 54C8 24 28 8 50 8 72 8 92 24 94 54Z"/><path d="M38 60H62L68 94H32Z"/>',
  cactus: `<path d="M50 94V10M50 58H24V34M50 44H76V24" fill="none" stroke="${INK}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`,
  cat: '<path d="M16 8 40 28H60L84 8 86 56C86 78 70 92 50 92 30 92 14 78 14 56Z"/>',
  lamp: `<path d="M30 8H70L84 48H16Z"/><path d="M50 48V84" fill="none" stroke="${INK}" stroke-width="8"/><path d="M26 92H74" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>`,
  kite: `<path d="M50 4 84 40 50 78 16 40Z"/><path d="M50 78C40 86 60 90 50 98" fill="none" stroke="${INK}" stroke-width="5"/>`,
};

function pattern(name, w, h) {
  const st = `fill="none" stroke="${INK}" stroke-width=".09"`;
  let out = '';
  if (name === 'stripes') for (let i = -h; i < w + h; i += .5) out += `<path d="M${i} 0L${i + h} ${h}" ${st}/>`;
  if (name === 'zigzag') for (let y = .35; y < h; y += .55) {
    let p = `M0 ${y}`;
    for (let x = 0; x < w + .4; x += .25) p += `L${x} ${y + (Math.round(x / .25) % 2 ? .2 : 0)}`;
    out += `<path d="${p}" ${st}/>`;
  }
  if (name === 'dots') for (let y = .4; y < h; y += .42) for (let x = .4; x < w; x += .42) out += `<circle cx="${x}" cy="${y}" r=".11" fill="${INK}"/>`;
  if (name === 'waves') for (let y = .4; y < h; y += .5) {
    let p = `M0 ${y}`;
    for (let x = 0; x < w + .5; x += .5) p += `Q${x + .125} ${y - .22} ${x + .25} ${y}T${x + .5} ${y}`;
    out += `<path d="${p}" ${st}/>`;
  }
  if (name === 'chevrons') for (let y = .1; y < h + .4; y += .5) out += `<path d="M0 ${y + .3}L${w / 2} ${y}L${w} ${y + .3}" ${st}/>`;
  if (name === 'scales') { let j = 0; for (let y = .35; y < h + .3; y += .36, j++) for (let x = j % 2 ? .3 : 0; x < w + .3; x += .6) out += `<path d="M${x - .3} ${y}A.3 .3 0 0 0 ${x + .3} ${y}" ${st}/>`; }
  return out;
}

export function artFor(name, w, h) {
  // The frame puts ink on every square, so no two squares of a picture look alike.
  const frame = `<rect x=".07" y=".07" width="${w - .14}" height="${h - .14}" rx=".06" fill="none" stroke="${INK}" stroke-width=".05"/>`;
  if (ICONS[name]) {
    const sz = Math.min(w, h) * .74;
    return `${frame}<g fill="${INK}" transform="translate(${(w - sz) / 2} ${(h - sz) / 2}) scale(${sz / 100})">${ICONS[name]}</g>`;
  }
  return `${frame}<svg x=".1" y=".1" width="${w - .2}" height="${h - .2}" viewBox=".1 .1 ${w - .2} ${h - .2}">${pattern(name, w, h)}</svg>`;
}

// Minimal QR code encoder: byte mode, error correction level M, versions 1–10 (up to 213 bytes).
// Enough for a pairing link; written here because the site has no build step or dependencies.
// Follows ISO/IEC 18004; structure after Project Nayuki's reference implementation (MIT).

// [ec codewords per block, [blocks, data codewords per block], ...] for level M
const BLOCKS_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EC_LEVEL_M_BITS = 0;

function dataCapacity(version) {
  const [, ...groups] = BLOCKS_M[version];
  return groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

// ---------- Reed–Solomon over GF(256), polynomial 0x11D ----------

function multiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function divisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data, div) {
  const result = new Array(div.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    div.forEach((coef, i) => { result[i] ^= multiply(coef, factor); });
  }
  return result;
}

// ---------- codewords ----------

function codewords(bytes, version) {
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  const capacityBits = dataCapacity(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  // split into blocks, add error correction, interleave
  const [ecLength, ...groups] = BLOCKS_M[version];
  const div = divisor(ecLength);
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: block, ec: remainder(block, div) });
    }
  }
  const result = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) blocks.forEach((b) => { if (i < b.data.length) result.push(b.data[i]); });
  for (let i = 0; i < ecLength; i++) blocks.forEach((b) => result.push(b.ec[i]));
  return result;
}

// ---------- matrix ----------

function createMatrix(version, words, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };

  // timing
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // finders + separators
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  // alignment
  const positions = ALIGNMENT[version];
  positions.forEach((ay, i) => positions.forEach((ax, j) => {
    const corner = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
    if (corner) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  // reserve format areas (filled later) and the dark module
  drawFormat(modules, reserved, size, 0, true);
  if (version >= 7) drawVersion(modules, reserved, size, version);

  // data, zigzag from the bottom right
  let bit = 0;
  const totalBits = words.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y][x]) continue;
        if (bit < totalBits) modules[y][x] = ((words[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
        bit++;
      }
    }
  }
  // mask
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && maskHit(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
  drawFormat(modules, reserved, size, mask, false);
  return modules;
}

function maskHit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function drawFormat(modules, reserved, size, mask, reserveOnly) {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bitAt = (i) => ((bits >>> i) & 1) === 1;
  const put = (x, y, dark) => { reserved[y][x] = true; if (!reserveOnly) modules[y][x] = dark; };
  for (let i = 0; i <= 5; i++) put(8, i, bitAt(i));
  put(8, 7, bitAt(6));
  put(8, 8, bitAt(7));
  put(7, 8, bitAt(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bitAt(i));
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bitAt(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bitAt(i));
  reserved[size - 8][8] = true;
  modules[size - 8][8] = true; // always dark
}

function drawVersion(modules, reserved, size, version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3), b = Math.floor(i / 3);
    modules[b][a] = dark; reserved[b][a] = true;
    modules[a][b] = dark; reserved[a][b] = true;
  }
}

// ---------- mask choice (standard penalty rules) ----------

function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i]);
    lines.push(modules.map((row) => row[i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) score += run - 2;
      run = 1;
    }
    const text = line.map((d) => (d ? '1' : '0')).join('');
    for (const pattern of ['10111010000', '00001011101']) {
      for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) score += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  const dark = modules.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 20) - (size * size * 10)) / (size * size)) * 10;
  return score;
}

/** @returns {boolean[][]} modules (true = dark), without the quiet zone */
export function encodeQr(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 10 && dataCapacity(version) < bytes.length + (version < 10 ? 2 : 3)) version++;
  if (version > 10) throw new Error('QR: text too long');
  const words = codewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = createMatrix(version, words, mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { modules, score };
  }
  return best.modules;
}

/** SVG markup with a 4-module quiet zone; colours come from the caller. */
export function qrSvg(text, { dark = '#000', light = '#fff', label = '' } = {}) {
  const modules = encodeQr(text);
  const size = modules.length + 8;
  let path = '';
  modules.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label}">`
    + `<rect width="${size}" height="${size}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

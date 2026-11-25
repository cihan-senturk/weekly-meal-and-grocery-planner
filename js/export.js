// Printable weekly menu (A4 portrait PNG), drawn on a canvas. No DOM besides the canvas it creates.
// Layout follows the printable weekly planners people use from template sites: a big title, the week,
// one row per day, a column per course, soft round shapes in the corners. Our palette, our fonts.

const WIDTH = 1654;               // A4 at 200 dpi
const HEIGHT = 2339;
const MARGIN = 110;
const DAY_COLUMN = 270;
const GAP = 22;

const COLORS = {
  burgundy: '#8e1523', tomato: '#ce4f2f', apricot: '#e29b6a', blush: '#f3b6b6',
  tint: '#fdf1ef', ink: '#2e1a17', muted: '#7a5a50', rule: 'rgba(142, 21, 35, .16)',
};
const DISPLAY = '"Sofia Sans Condensed", "Arial Narrow", sans-serif';
const BODY = '"Sofia Sans", system-ui, sans-serif';

/**
 * @param {object} menu
 * @param {string} menu.title        "Haftalık Menü"
 * @param {string} menu.subtitle     "23–29 Kasım"
 * @param {string[]} menu.courses    course labels, one per column
 * @param {Array<{name:string, date:string, note?:string, muted?:boolean,
 *          cells: Array<null | {text:string, color:string, leftover?:boolean}>}>} menu.days
 * @param {string} menu.brand        small footer text, left
 * @param {string} menu.signoff      small footer text, right
 * @param {string} menu.leftoverMark text after a leftover dish, e.g. "artan"
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function drawMenu(menu) {
  await loadFonts();
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawDecoration(ctx);

  // heading
  let y = MARGIN + 30;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.tomato;
  ctx.font = `700 34px ${BODY}`;
  drawSpaced(ctx, menu.subtitle.toLocaleUpperCase('tr'), MARGIN, y, 6);
  y += 128;
  ctx.fillStyle = COLORS.burgundy;
  ctx.font = `800 140px ${DISPLAY}`;
  ctx.fillText(menu.title, MARGIN - 4, y);

  // course header
  y += 92;
  const columns = columnLayout(menu.courses.length);
  ctx.font = `700 32px ${DISPLAY}`;
  ctx.fillStyle = COLORS.burgundy;
  menu.courses.forEach((label, i) => ctx.fillText(label, columns[i].x, y));
  y += 22;
  ctx.fillStyle = COLORS.burgundy;
  ctx.fillRect(MARGIN, y, WIDTH - 2 * MARGIN, 4);
  y += 20;

  // day rows
  const footerTop = HEIGHT - MARGIN - 40;
  const rowHeight = Math.floor((footerTop - y - 30) / menu.days.length) - 12;
  menu.days.forEach((day, index) => {
    if (index % 2 === 0) {
      ctx.fillStyle = COLORS.tint;
      roundRect(ctx, MARGIN - 24, y, WIDTH - 2 * MARGIN + 48, rowHeight, 28);
      ctx.fill();
    }
    drawDay(ctx, day, y, rowHeight, columns, menu.leftoverMark);
    y += rowHeight + 12;
  });

  // footer
  ctx.fillStyle = COLORS.burgundy;
  ctx.font = `800 36px ${DISPLAY}`;
  ctx.fillText(menu.brand, MARGIN, HEIGHT - MARGIN + 10);
  ctx.fillStyle = COLORS.tomato;
  ctx.font = `italic 600 36px ${BODY}`;
  ctx.textAlign = 'right';
  ctx.fillText(menu.signoff, WIDTH - MARGIN, HEIGHT - MARGIN + 10);
  ctx.textAlign = 'left';
  return canvas;
}

function columnLayout(count) {
  const left = MARGIN + DAY_COLUMN;
  const width = (WIDTH - MARGIN - left - GAP * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({ x: left + i * (width + GAP), width }));
}

function drawDay(ctx, day, top, height, columns, leftoverMark) {
  const middle = top + height / 2;
  ctx.fillStyle = COLORS.burgundy;
  ctx.font = `700 58px ${DISPLAY}`;
  ctx.fillText(day.name, MARGIN, middle + 4);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `600 28px ${BODY}`;
  ctx.fillText(day.date, MARGIN + 2, middle + 46);
  if (day.note) {
    ctx.fillStyle = COLORS.tomato;
    ctx.font = `700 26px ${BODY}`;
    ctx.fillText(day.note, MARGIN + 2 + ctx.measureText(`${day.date}  `).width + 8, middle + 46);
  }

  const hasDish = day.cells.some(Boolean);
  if (!hasDish && day.note) {
    // eating out, nothing entered: one quiet line across the courses
    ctx.strokeStyle = COLORS.blush;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 12]);
    ctx.beginPath();
    ctx.moveTo(columns[0].x, middle);
    ctx.lineTo(columns.at(-1).x + columns.at(-1).width, middle);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  day.cells.forEach((cell, i) => {
    const { x, width } = columns[i];
    if (!cell) {
      // an empty slot is a short line to write on by hand
      ctx.fillStyle = COLORS.rule;
      ctx.fillRect(x, middle + 16, width * 0.7, 3);
      return;
    }
    ctx.font = `${cell.leftover ? 'italic 500' : '600'} 42px ${DISPLAY}`;
    const lines = wrap(ctx, cell.text, width - 28, 3);
    const lineHeight = 46;
    let y = middle - ((lines.length - 1) * lineHeight) / 2 + 12;
    ctx.fillStyle = cell.color;
    ctx.beginPath();
    ctx.arc(x + 7, y - 14, 8, 0, Math.PI * 2); // beside the first line
    if (cell.leftover) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = cell.color;
      ctx.stroke();
    } else {
      ctx.fill();
    }
    ctx.fillStyle = cell.leftover || day.muted ? COLORS.muted : COLORS.ink;
    for (const line of lines) {
      ctx.fillText(line, x + 26, y);
      y += lineHeight;
    }
    if (cell.leftover) {
      ctx.font = `600 24px ${BODY}`;
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(leftoverMark, x + 26, y - 6);
    }
  });
}

/** Soft overlapping circles in two corners, cut by the page edge. */
function drawDecoration(ctx) {
  const circle = (x, y, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.globalAlpha = 0.55;
  circle(WIDTH - 120, 70, 240, COLORS.blush);
  ctx.globalAlpha = 0.5;
  circle(WIDTH - 330, -40, 150, COLORS.apricot);
  ctx.globalAlpha = 0.9;
  circle(WIDTH - 210, 250, 26, COLORS.tomato);
  ctx.globalAlpha = 0.35;
  circle(-60, HEIGHT - 40, 190, COLORS.blush);
  ctx.globalAlpha = 0.45;
  circle(150, HEIGHT + 40, 110, COLORS.apricot);
  ctx.globalAlpha = 1;
}

function drawSpaced(ctx, text, x, y, spacing) {
  for (const char of text) {
    ctx.fillText(char, x, y);
    x += ctx.measureText(char).width + spacing;
  }
}

/** Word wrap with a line limit; the last line gets an ellipsis if text is left over. */
function wrap(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** Canvas text only uses web fonts once they are loaded. */
async function loadFonts() {
  if (!document.fonts?.load) return;
  try {
    await Promise.all([
      document.fonts.load(`800 140px ${DISPLAY}`), document.fonts.load(`700 54px ${DISPLAY}`),
      document.fonts.load(`italic 500 36px ${DISPLAY}`), document.fonts.load(`600 28px ${BODY}`),
      document.fonts.load(`italic 600 36px ${BODY}`),
    ]);
  } catch {
    // fall back to system fonts
  }
}

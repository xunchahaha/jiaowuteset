// 分享卡片：用离屏 canvas 按页面内容画一张封面图，替代微信默认的页面截图。
// drawShareCard 只依赖 CanvasRenderingContext2D，浏览器里也能直接跑（方便预览）；
// renderShareImage 负责微信侧的离屏画布、导出临时文件与缓存，任何一步失败都返回 ''，
// 调用方据此回退成不带 imageUrl 的普通分享。

const BRAND_NAME = '教务助手';
const LOGO_SRC = '/assets/brand.png';

const SIZES = {
  message: { width: 750, height: 600 },   // 会话卡片 5:4
  timeline: { width: 500, height: 500 }   // 朋友圈 1:1
};

const THEMES = {
  blue: { from: '#4a86c5', to: '#274f7c', accent: '#376da6', soft: '#edf3fa' },
  green: { from: '#4f9a7d', to: '#2b5f4b', accent: '#397560', soft: '#eef6f1' },
  amber: { from: '#d0904a', to: '#8f5527', accent: '#a5652f', soft: '#fbf3ea' },
  teal: { from: '#3f9aa0', to: '#215f68', accent: '#2e7d80', soft: '#ebf5f5' },
  plum: { from: '#8d6fb8', to: '#523c7a', accent: '#6b519a', soft: '#f3eff9' },
  slate: { from: '#5b6fd1', to: '#2f3b85', accent: '#4555b8', soft: '#eef0fb' },
  red: { from: '#cf6b6b', to: '#8a3636', accent: '#b84c4c', soft: '#fbefef' }
};

const INK = '#24354b';
const MUTED = '#69798b';
const LINE = '#e4eaf0';
const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';

const MAX_CACHE = 24;
const cache = {};
const cacheOrder = [];
const pending = {};

// ---------- 纯数据 ----------

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeSpec(spec) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const theme = THEMES[source.theme] ? source.theme : 'blue';
  const rows = (Array.isArray(source.rows) ? source.rows : [])
    .map((row) => ({ label: text(row && row.label), text: text(row && row.text) }))
    .filter((row) => row.text)
    .slice(0, 3);
  const stats = (Array.isArray(source.stats) ? source.stats : [])
    .map((item) => ({ value: text(item && item.value) || '-', label: text(item && item.label) }))
    .filter((item) => item.label)
    .slice(0, 3);
  const chips = (Array.isArray(source.chips) ? source.chips : []).map(text).filter(Boolean).slice(0, 6);
  const percent = Number(source.progress);
  return {
    theme,
    eyebrow: text(source.eyebrow),
    headline: text(source.headline) || BRAND_NAME,
    sub: text(source.sub),
    rows,
    stats,
    chips,
    note: text(source.note),
    progress: isFinite(percent) && source.progress !== null && source.progress !== '' ? Math.max(0, Math.min(100, Math.round(percent))) : null,
    progressLabel: text(source.progressLabel)
  };
}

function specKey(kind, spec) {
  return kind + '|' + JSON.stringify(normalizeSpec(spec));
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatDateKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function formatDayLabel(date) {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + weekdays[date.getDay()];
}

// 课表网格（dayColumns）里取某一天的课，转成卡片行；同名同时间的重复格子只留一个。
function lessonRowsForDate(dayColumns, dateKey) {
  const column = (Array.isArray(dayColumns) ? dayColumns : []).find((item) => item && item.date === dateKey);
  const lessons = column && Array.isArray(column.lessons) ? column.lessons.slice() : [];
  lessons.sort((a, b) => (a.startUnit || 99) - (b.startUnit || 99) || text(a.startTime).localeCompare(text(b.startTime)));
  const seen = {};
  const rows = [];
  lessons.forEach((lesson) => {
    const name = text(lesson && lesson.courseName);
    if (!name) {
      return;
    }
    const label = text(lesson.startTime) || text(lesson.unitText) || '—';
    const key = name + '|' + label;
    if (seen[key]) {
      return;
    }
    seen[key] = true;
    rows.push({ label, text: [name, text(lesson.place)].filter(Boolean).join(' · ') });
  });
  return rows;
}

// ---------- 绘制 ----------

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function setFont(ctx, size, weight) {
  ctx.font = (weight || 'normal') + ' ' + size + 'px ' + FONT;
}

function ellipsize(ctx, value, maxWidth) {
  if (ctx.measureText(value).width <= maxWidth) {
    return value;
  }
  let result = value;
  while (result.length > 1 && ctx.measureText(result + '…').width > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + '…';
}

// 按字符折行（中文无空格），最多 maxLines 行，末行超出加省略号。
function wrapLines(ctx, value, maxWidth, maxLines) {
  const lines = [];
  let current = '';
  const chars = Array.from(value);
  for (let i = 0; i < chars.length; i += 1) {
    const next = current + chars[i];
    if (current && ctx.measureText(next).width > maxWidth) {
      if (lines.length === maxLines - 1) {
        lines.push(ellipsize(ctx, current + chars.slice(i).join(''), maxWidth));
        return lines;
      }
      lines.push(current);
      current = chars[i];
    } else {
      current = next;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

// 标题先尝试单行大字，放不下就缩字号，再不行折两行。
function fitHeadline(ctx, value, maxWidth, sizes) {
  for (let i = 0; i < sizes.length; i += 1) {
    setFont(ctx, sizes[i], 'bold');
    if (ctx.measureText(value).width <= maxWidth) {
      return { size: sizes[i], lines: [value] };
    }
  }
  const size = sizes[sizes.length - 1];
  setFont(ctx, size, 'bold');
  // 两行尽量等长，避免第二行只剩一两个字
  const total = ctx.measureText(value).width;
  for (let width = Math.ceil(total / 2); width < maxWidth; width += size / 2) {
    const lines = wrapLines(ctx, value, width, 2);
    if (lines.length <= 2 && !lines[lines.length - 1].endsWith('…')) {
      return { size, lines };
    }
  }
  return { size, lines: wrapLines(ctx, value, maxWidth, 2) };
}

function drawBackground(ctx, width, height, theme) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, theme.from);
  gradient.addColorStop(1, theme.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.arc(width - 40, -30, width * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.beginPath();
  ctx.arc(width * 0.78, height * 0.3, width * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(width * 0.08, height * 0.95, width * 0.22, 0, Math.PI * 2);
  ctx.stroke();
}

function drawLogo(ctx, logo, x, y, size) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y, size, size, size * 0.26);
  ctx.fill();
  ctx.restore();
  if (logo) {
    ctx.save();
    roundRect(ctx, x, y, size, size, size * 0.26);
    ctx.clip();
    // 原图四周留白较多，略微放大裁掉
    const inset = size * 0.12;
    ctx.drawImage(logo, x - inset, y - inset, size + inset * 2, size + inset * 2);
    ctx.restore();
  }
}

function drawPill(ctx, label, rightX, centerY, height, fill, color, fontSize) {
  setFont(ctx, fontSize, 'bold');
  const width = ctx.measureText(label).width + height;
  ctx.fillStyle = fill;
  roundRect(ctx, rightX - width, centerY - height / 2, width, height, height / 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, rightX - width / 2, centerY + 1);
  ctx.textAlign = 'left';
  return width;
}

function drawRows(ctx, rows, box, theme) {
  const rowHeight = Math.min(84, box.height / rows.length);
  const top = box.y + (box.height - rowHeight * rows.length) / 2;
  const labelWidth = 128;
  rows.forEach((row, index) => {
    const y = top + rowHeight * index;
    const centerY = y + rowHeight / 2;
    if (index > 0) {
      ctx.fillStyle = LINE;
      ctx.fillRect(box.x, y, box.width, 2);
    }
    ctx.fillStyle = theme.soft;
    roundRect(ctx, box.x, centerY - 22, labelWidth, 44, 12);
    ctx.fill();
    setFont(ctx, 24, 'bold');
    ctx.fillStyle = theme.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, row.label || '·', labelWidth - 16), box.x + labelWidth / 2, centerY + 1);
    ctx.textAlign = 'left';
    setFont(ctx, 30, 'normal');
    ctx.fillStyle = INK;
    ctx.fillText(ellipsize(ctx, row.text, box.width - labelWidth - 24), box.x + labelWidth + 24, centerY + 1);
  });
}

function drawStats(ctx, stats, box, theme) {
  const cellWidth = box.width / stats.length;
  stats.forEach((item, index) => {
    const centerX = box.x + cellWidth * index + cellWidth / 2;
    if (index > 0) {
      ctx.fillStyle = LINE;
      ctx.fillRect(box.x + cellWidth * index, box.y + box.height * 0.22, 2, box.height * 0.56);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    setFont(ctx, 56, 'bold');
    ctx.fillStyle = theme.accent;
    ctx.fillText(ellipsize(ctx, item.value, cellWidth - 24), centerX, box.y + box.height / 2 + 8);
    setFont(ctx, 24, 'normal');
    ctx.fillStyle = MUTED;
    ctx.fillText(ellipsize(ctx, item.label, cellWidth - 24), centerX, box.y + box.height / 2 + 52);
  });
  ctx.textAlign = 'left';
}

function drawProgress(ctx, spec, box, theme) {
  const barY = box.y + box.height / 2 + (spec.note ? -8 : 20);
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 28, 'normal');
  ctx.fillStyle = MUTED;
  ctx.fillText(ellipsize(ctx, spec.progressLabel || '整体进度', box.width - 140), box.x, barY - 32);
  setFont(ctx, 40, 'bold');
  ctx.fillStyle = theme.accent;
  ctx.textAlign = 'right';
  ctx.fillText(spec.progress + '%', box.x + box.width, barY - 28);
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.soft;
  roundRect(ctx, box.x, barY, box.width, 24, 12);
  ctx.fill();
  if (spec.progress > 0) {
    const gradient = ctx.createLinearGradient(box.x, 0, box.x + box.width, 0);
    gradient.addColorStop(0, theme.from);
    gradient.addColorStop(1, theme.accent);
    ctx.fillStyle = gradient;
    roundRect(ctx, box.x, barY, Math.max(24, box.width * spec.progress / 100), 24, 12);
    ctx.fill();
  }
  if (spec.note) {
    setFont(ctx, 24, 'normal');
    ctx.fillStyle = MUTED;
    ctx.fillText(ellipsize(ctx, spec.note, box.width), box.x, barY + 72);
  }
}

function drawChips(ctx, chips, box, theme, topOffset) {
  const columns = 3;
  const gap = 16;
  const rowsCount = Math.ceil(chips.length / columns);
  const roomy = rowsCount === 1 && topOffset === undefined;
  const chipHeight = roomy ? 112 : 52;
  const chipWidth = (box.width - gap * (columns - 1)) / columns;
  const startY = topOffset !== undefined ? topOffset : box.y + (box.height - (rowsCount * chipHeight + (rowsCount - 1) * gap)) / 2;
  setFont(ctx, roomy ? 28 : 24, 'bold');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  chips.forEach((chip, index) => {
    const x = box.x + (index % columns) * (chipWidth + gap);
    const y = startY + Math.floor(index / columns) * (chipHeight + gap);
    ctx.fillStyle = theme.soft;
    roundRect(ctx, x, y, chipWidth, chipHeight, roomy ? 20 : 14);
    ctx.fill();
    ctx.fillStyle = theme.accent;
    ctx.fillText(ellipsize(ctx, chip, chipWidth - 20), x + chipWidth / 2, y + chipHeight / 2 + 1);
  });
  ctx.textAlign = 'left';
}

function drawNote(ctx, spec, box, theme) {
  setFont(ctx, 32, 'normal');
  if (!spec.chips.length && ctx.measureText(spec.note).width <= box.width) {
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.note, box.x + box.width / 2, box.y + box.height / 2);
    ctx.textAlign = 'left';
    return;
  }
  setFont(ctx, 28, 'normal');
  const lines = wrapLines(ctx, spec.note, box.width, spec.chips.length ? 1 : 3);
  const lineHeight = 42;
  const chipsHeight = spec.chips.length ? Math.ceil(spec.chips.length / 3) * 68 - 16 : 0;
  const total = lines.length * lineHeight + (chipsHeight ? chipsHeight + 20 : 0);
  let y = box.y + (box.height - total) / 2;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'top';
  lines.forEach((line) => {
    ctx.fillText(line, box.x, y + 4);
    y += lineHeight;
  });
  if (spec.chips.length) {
    drawChips(ctx, spec.chips, box, theme, y + 20);
  }
}

function drawPanelContent(ctx, spec, box, theme) {
  if (spec.progress !== null) {
    drawProgress(ctx, spec, box, theme);
  } else if (spec.stats.length) {
    drawStats(ctx, spec.stats, box, theme);
  } else if (spec.rows.length) {
    drawRows(ctx, spec.rows, box, theme);
  } else if (spec.note) {
    drawNote(ctx, spec, box, theme);
  } else if (spec.chips.length) {
    drawChips(ctx, spec.chips, box, theme);
  }
}

function drawMessageCard(ctx, spec, theme, logo, width, height) {
  const margin = 48;
  drawLogo(ctx, logo, margin, 40, 60);
  setFont(ctx, 30, 'bold');
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(BRAND_NAME, margin + 78, 71);
  if (spec.eyebrow) {
    drawPill(ctx, spec.eyebrow, width - margin, 70, 48, 'rgba(255, 255, 255, 0.2)', '#ffffff', 24);
  }

  const headline = fitHeadline(ctx, spec.headline, width - margin * 2, [68, 58, 48]);
  setFont(ctx, headline.size, 'bold');
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  let cursor = 132;
  headline.lines.forEach((line) => {
    cursor += headline.size * 1.15;
    ctx.fillText(line, margin, cursor);
  });
  if (spec.sub) {
    setFont(ctx, 28, 'normal');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    cursor += 48;
    ctx.fillText(ellipsize(ctx, spec.sub, width - margin * 2), margin, cursor);
  }

  const hasPanel = spec.progress !== null || spec.stats.length || spec.rows.length || spec.note || spec.chips.length;
  if (!hasPanel) {
    return;
  }
  const panelTop = Math.max(300, cursor + 36);
  const panel = { x: 32, y: panelTop, width: width - 64, height: height - 32 - panelTop };
  ctx.save();
  ctx.shadowColor = 'rgba(16, 32, 56, 0.18)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, panel.x, panel.y, panel.width, panel.height, 28);
  ctx.fill();
  ctx.restore();
  drawPanelContent(ctx, spec, {
    x: panel.x + 32,
    y: panel.y + 16,
    width: panel.width - 64,
    height: panel.height - 32
  }, theme);
}

// 朋友圈缩略图很小，只放 logo + 标题 + 副标题，居中排版。
function drawTimelineCard(ctx, spec, theme, logo, width, height) {
  const logoSize = 120;
  drawLogo(ctx, logo, (width - logoSize) / 2, 72, logoSize);
  const headline = spec.progress !== null ? spec.progress + '%' : spec.headline;
  const fitted = fitHeadline(ctx, headline, width - 72, [64, 54, 44]);
  setFont(ctx, fitted.size, 'bold');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  let cursor = 236;
  fitted.lines.forEach((line) => {
    cursor += fitted.size * 1.15;
    ctx.fillText(line, width / 2, cursor);
  });
  const sub = spec.progress !== null ? spec.headline : (spec.sub || spec.eyebrow);
  if (sub) {
    setFont(ctx, 28, 'normal');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(ellipsize(ctx, sub, width - 72), width / 2, cursor + 52);
  }
  setFont(ctx, 24, 'bold');
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.fillText(BRAND_NAME, width / 2, height - 40);
  ctx.textAlign = 'left';
}

function drawShareCard(ctx, rawSpec, options) {
  const opts = options || {};
  const kind = opts.kind === 'timeline' ? 'timeline' : 'message';
  const size = SIZES[kind];
  const width = opts.width || size.width;
  const height = opts.height || size.height;
  const spec = normalizeSpec(rawSpec);
  const theme = THEMES[spec.theme];
  ctx.save();
  ctx.scale(width / size.width, height / size.height);
  drawBackground(ctx, size.width, size.height, theme);
  if (kind === 'timeline') {
    drawTimelineCard(ctx, spec, theme, opts.logo || null, size.width, size.height);
  } else {
    drawMessageCard(ctx, spec, theme, opts.logo || null, size.width, size.height);
  }
  ctx.restore();
}

// ---------- 微信侧渲染 ----------

function canRender() {
  return typeof wx !== 'undefined' && typeof wx.createOffscreenCanvas === 'function';
}

function loadLogo(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.createImage !== 'function') {
      resolve(null);
      return;
    }
    const image = canvas.createImage();
    const timer = setTimeout(() => resolve(null), 1200);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    image.src = LOGO_SRC;
  });
}

function writeDataUrl(canvas, key) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toDataURL !== 'function' || !wx.env || !wx.getFileSystemManager) {
      reject(new Error('toDataURL unsupported'));
      return;
    }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    const filePath = wx.env.USER_DATA_PATH + '/share-card-' + (hash >>> 0).toString(36) + '.jpg';
    wx.getFileSystemManager().writeFile({
      filePath,
      data: base64,
      encoding: 'base64',
      success: () => resolve(filePath),
      fail: reject
    });
  });
}

function exportCanvas(canvas, size, key) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      destWidth: size.width,
      destHeight: size.height,
      fileType: 'jpg',
      quality: 0.92,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    });
  }).catch(() => writeDataUrl(canvas, key));
}

function remember(key, path) {
  if (!cache[key]) {
    cacheOrder.push(key);
  }
  cache[key] = path;
  while (cacheOrder.length > MAX_CACHE) {
    delete cache[cacheOrder.shift()];
  }
}

function getCachedShareImage(kind, spec) {
  return cache[specKey(kind, spec)] || '';
}

function renderShareImage(kind, spec) {
  const key = specKey(kind, spec);
  if (cache[key]) {
    return Promise.resolve(cache[key]);
  }
  if (pending[key]) {
    return pending[key];
  }
  if (!canRender()) {
    return Promise.resolve('');
  }
  const size = SIZES[kind] || SIZES.message;
  const job = Promise.resolve()
    .then(() => {
      const canvas = wx.createOffscreenCanvas({ type: '2d', width: size.width, height: size.height });
      return loadLogo(canvas).then((logo) => {
        drawShareCard(canvas.getContext('2d'), spec, { kind, logo, width: size.width, height: size.height });
        return exportCanvas(canvas, size, key);
      });
    })
    .then((path) => {
      delete pending[key];
      if (path) {
        remember(key, path);
      }
      return path || '';
    }, () => {
      delete pending[key];
      return '';
    });
  pending[key] = job;
  return job;
}

module.exports = {
  SIZES,
  THEMES,
  drawShareCard,
  normalizeSpec,
  specKey,
  formatDateKey,
  formatDayLabel,
  lessonRowsForDate,
  renderShareImage,
  getCachedShareImage
};

// 見出し画像（note 推奨 1280×670px）をブラウザの Canvas で作る。外部サービスは使わない。

export const COVER_WIDTH = 1280;
export const COVER_HEIGHT = 670;

const THEMES = {
  paid: { from: "#12463a", to: "#1f6f5c", accent: "#f2c14e", text: "#ffffff", sub: "#d8efe7" },
  free: { from: "#e9f5f0", to: "#cfe9df", accent: "#1f6f5c", text: "#13332b", sub: "#2f5a4f" },
};

// 行頭に来てはいけない文字（簡易の禁則処理）
const NO_LINE_START = "、。，．・：；？！）」』】〉》ー々ぁぃぅぇぉっゃゅょァィゥェォッャュョ…";
// 行末に来てはいけない文字（開きかっこ）
const NO_LINE_END = "「『（【〈《";

/** タイトルを「主題」と「副題」に分ける（最初の「: 」または「：」で区切る） */
export function splitTitle(title) {
  const m = /^(.+?)\s*[:：]\s*(.+)$/.exec(title.trim());
  return m ? { main: m[1], sub: m[2] } : { main: title.trim(), sub: "" };
}

/** 幅に収まるように1文字ずつ折り返す（英単語はなるべく切らない） */
export function wrapText(ctx, text, maxWidth) {
  // 英数字の単語・カタカナの語・数字＋助数詞はひとまとまりにして、途中で折り返さない
  // 短いかぎかっこ（8文字以内）も、ひとまとまりにする
  const tokens = text.match(/「[^」]{1,8}」|[0-9０-９]+[つ個本件章]|[A-Za-z0-9.\-_/]+|[ァ-ヶー]+|\s+|./gu) ?? [];
  const lines = [];
  let line = "";
  for (const t of tokens) {
    const next = line + t;
    if (ctx.measureText(next).width <= maxWidth || line === "") {
      line = next;
      continue;
    }
    if (NO_LINE_START.includes(t[0])) {
      // 禁則文字は前の行にぶら下げる
      line = next;
      continue;
    }
    // 開きかっこで終わる行は、そのかっこを次の行へ送る
    let carry = "";
    while (line.length > 1 && NO_LINE_END.includes(line.at(-1))) {
      carry = line.at(-1) + carry;
      line = line.slice(0, -1);
    }
    lines.push(line.trimEnd());
    line = (carry + t).trimStart();
  }
  if (line.trim() !== "") lines.push(line.trimEnd());
  return lines;
}

const GOTHIC = `"Noto Sans JP", "Hiragino Sans", system-ui, sans-serif`;
// 明朝体（写真・イラストの上に重ねると、雑誌や映画のポスターのような雰囲気になる）
const MINCHO = `"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", serif`;

function fitLines(ctx, text, maxWidth, maxLines, startSize, minSize, weight, family = GOTHIC) {
  for (let size = startSize; size >= minSize; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    const lines = wrapText(ctx, text, maxWidth);
    // 最後の行が1〜2文字だけになる（取り残される）大きさは避ける
    const orphan = lines.length > 1 && [...lines.at(-1)].length <= 2;
    if (lines.length <= maxLines && !orphan) return { size, lines };
  }
  ctx.font = `${weight} ${minSize}px ${family}`;
  return { size: minSize, lines: wrapText(ctx, text, maxWidth).slice(0, maxLines) };
}

/** 画像を枠いっぱいに、はみ出した分は切って描く（CSS の object-fit: cover と同じ） */
function drawImageCover(ctx, img, w, h) {
  const iw = img.width;
  const ih = img.height;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * 背景画像（ChatGPT などで作ったイラスト）に、タイトルを影付きの白い文字で重ねる。
 * position: 文字を置く側（イラストの余白に合わせる）。font: "mincho" | "gothic"
 */
function drawPhotoCover(canvas, ctx, { main, sub, label, background, position, font }) {
  drawImageCover(ctx, background, COVER_WIDTH, COVER_HEIGHT);
  // 文字の側を少し暗くして読みやすくする
  const shade =
    position === "center"
      ? ctx.createLinearGradient(0, 0, 0, COVER_HEIGHT)
      : ctx.createLinearGradient(position === "right" ? COVER_WIDTH : 0, 0, position === "right" ? 0 : COVER_WIDTH, 0);
  if (position === "center") {
    shade.addColorStop(0, "rgba(0,0,0,0.15)");
    shade.addColorStop(0.5, "rgba(0,0,0,0.45)");
    shade.addColorStop(1, "rgba(0,0,0,0.15)");
  } else {
    shade.addColorStop(0, "rgba(0,0,0,0.55)");
    shade.addColorStop(0.55, "rgba(0,0,0,0.15)");
    shade.addColorStop(0.8, "rgba(0,0,0,0)");
  }
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);

  const family = font === "gothic" ? GOTHIC : MINCHO;
  const boxWidth = position === "center" ? COVER_WIDTH - 240 : COVER_WIDTH * 0.56;
  const mainFit = fitLines(ctx, main, boxWidth, 3, 104, 52, 900, family);
  const subFit = sub ? fitLines(ctx, sub, boxWidth, 2, 38, 26, 700, family) : { size: 0, lines: [] };
  const labelSize = 30;
  const mainHeight = mainFit.lines.length * mainFit.size * 1.2;
  const subHeight = subFit.lines.length * subFit.size * 1.4;
  const labelHeight = label ? labelSize * 1.8 : 0;
  const total = labelHeight + mainHeight + (sub ? 24 : 0) + subHeight;
  let y = (COVER_HEIGHT - total) / 2;

  ctx.textBaseline = "top";
  ctx.textAlign = position === "center" ? "center" : "left";
  const x = position === "center" ? COVER_WIDTH / 2 : position === "right" ? COVER_WIDTH - 90 - boxWidth : 90;
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 3;
  if (label) {
    ctx.font = `700 ${labelSize}px ${family}`;
    ctx.fillText(label, x, y);
    y += labelHeight;
  }
  ctx.font = `900 ${mainFit.size}px ${family}`;
  for (const line of mainFit.lines) {
    ctx.fillText(line, x, y);
    y += mainFit.size * 1.2;
  }
  y += sub ? 24 : 0;
  ctx.font = `700 ${subFit.size}px ${family}`;
  for (const line of subFit.lines) {
    ctx.fillText(line, x, y);
    y += subFit.size * 1.4;
  }
  ctx.shadowColor = "transparent";
  ctx.textAlign = "left";
  return canvas;
}

/**
 * Canvas に見出し画像を描く。
 * @param {HTMLCanvasElement} canvas
 * background を渡すと、その画像の上にタイトルを重ねる（なければ単色のグラデーション）。
 * @param {{ main: string, sub?: string, label?: string, variant?: "paid" | "free",
 *   background?: CanvasImageSource & { width: number, height: number } | null,
 *   position?: "left" | "right" | "center", font?: "mincho" | "gothic" }} opts
 */
export function drawCover(canvas, { main, sub = "", label = "", variant = "paid", background = null, position = "left", font = "mincho" }) {
  const t = THEMES[variant] ?? THEMES.paid;
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (background) return drawPhotoCover(canvas, ctx, { main, sub, label, background, position, font });

  const g = ctx.createLinearGradient(0, 0, COVER_WIDTH, COVER_HEIGHT);
  g.addColorStop(0, t.from);
  g.addColorStop(1, t.to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);

  // 飾り: 右下の円と左の縦帯
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = t.accent;
  ctx.beginPath();
  ctx.arc(COVER_WIDTH - 120, COVER_HEIGHT + 40, 300, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillRect(96, 150, 10, 300);

  // 端は SNS などでトリミングされることがあるので、文字は内側に収める
  const left = 140;
  const maxWidth = COVER_WIDTH - left - 120;
  ctx.textBaseline = "top";

  if (label) {
    ctx.font = `700 30px "Noto Sans JP", "Hiragino Sans", system-ui, sans-serif`;
    ctx.fillStyle = t.accent;
    ctx.fillText(label, left, 110);
  }

  const mainFit = fitLines(ctx, main, maxWidth, 3, 76, 44, 800);
  const subFit = sub ? fitLines(ctx, sub, maxWidth, 2, 36, 26, 500) : { size: 0, lines: [] };
  const mainHeight = mainFit.lines.length * mainFit.size * 1.3;
  const subHeight = subFit.lines.length * subFit.size * 1.45;
  const gap = sub ? 28 : 0;
  let y = Math.max(160, (COVER_HEIGHT - (mainHeight + gap + subHeight)) / 2 + 20);

  ctx.font = `800 ${mainFit.size}px "Noto Sans JP", "Hiragino Sans", system-ui, sans-serif`;
  ctx.fillStyle = t.text;
  for (const line of mainFit.lines) {
    ctx.fillText(line, left, y);
    y += mainFit.size * 1.3;
  }
  y += gap;
  ctx.font = `500 ${subFit.size}px "Noto Sans JP", "Hiragino Sans", system-ui, sans-serif`;
  ctx.fillStyle = t.sub;
  for (const line of subFit.lines) {
    ctx.fillText(line, left, y);
    y += subFit.size * 1.45;
  }
  return canvas;
}

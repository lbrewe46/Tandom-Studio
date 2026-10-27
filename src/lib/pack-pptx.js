// Draws the slides from buildPack (src/lib/plans.js) into a PowerPoint file with PptxGenJS. The library is loaded from a CDN
// only when someone clicks "Download PowerPoint", so it adds nothing to the app bundle and nothing to package.json.

const PPTX_URL = "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js";

export function loadPptxGen() {
  if (typeof window === "undefined") return Promise.reject(new Error("PowerPoint export runs in the browser."));
  if (window.PptxGenJS) return Promise.resolve(window.PptxGenJS);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = PPTX_URL; el.async = true;
    el.onload = () => (window.PptxGenJS ? resolve(window.PptxGenJS) : reject(new Error("The PowerPoint library loaded but wasn't usable.")));
    el.onerror = () => reject(new Error("Couldn't load the PowerPoint library (are you online, and does your network allow cdn.jsdelivr.net?)."));
    document.head.appendChild(el);
  });
}

const NAVY = "1E293B", AMBER = "D97706", GREY = "64748B", LIGHT = "F1F5F9", FONT = "Calibri";

// Draws every slide onto `pptx` (a PptxGenJS instance). Kept free of browser code so it can be tested with a stand-in.
export function renderPack(pptx, slides, { preparedBy = "" } = {}) {
  pptx.layout = "LAYOUT_WIDE"; // 13.33in x 7.5in
  const footer = (slide, n) => {
    slide.addText(preparedBy ? `${preparedBy}  ·  ${n}` : String(n), { x: 0.5, y: 7.05, w: 12.3, h: 0.3, fontSize: 10, color: GREY, fontFace: FONT, align: "right" });
  };
  const heading = (slide, title) => {
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: AMBER }, line: { color: AMBER } });
    slide.addText(title, { x: 0.5, y: 0.35, w: 12.3, h: 0.8, fontSize: 28, bold: true, color: NAVY, fontFace: FONT });
  };
  const bullets = (slide, list, y = 1.5, h = 4.8) => {
    slide.addText(list.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.6, y, w: 12.1, h, fontSize: 20, color: NAVY, fontFace: FONT, valign: "top", paraSpaceAfter: 10 });
  };
  const table = (slide, columns, rows, colW) => {
    const head = columns.map((c) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: NAVY }, fontFace: FONT, fontSize: 14 } }));
    const body = rows.map((r) => (Array.isArray(r) ? r : [r.planogram, r.adds, r.removes, r.net]).map((cell) => ({ text: String(cell ?? ""), options: { fontFace: FONT, fontSize: 13, color: NAVY } })));
    slide.addTable([head, ...body], { x: 0.5, y: 1.4, w: 12.3, colW, border: { type: "solid", pt: 0.5, color: "CBD5E1" }, valign: "middle", rowH: 0.55 });
  };
  slides.forEach((s, idx) => {
    const slide = pptx.addSlide();
    if (s.kind === "title") {
      slide.background = { color: NAVY };
      slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 2.55, w: 1.2, h: 0.08, fill: { color: AMBER }, line: { color: AMBER } });
      slide.addText(s.title, { x: 0.6, y: 2.8, w: 12, h: 1.4, fontSize: 40, bold: true, color: "FFFFFF", fontFace: FONT, valign: "top" });
      slide.addText(s.subtitle, { x: 0.6, y: 4.2, w: 12, h: 0.6, fontSize: 22, color: "CBD5E1", fontFace: FONT });
      const who = [s.preparedFor ? `Prepared for ${s.preparedFor}` : "", s.preparedBy ? `Prepared by ${s.preparedBy}` : "", s.date].filter(Boolean).join("   ·   ");
      if (who) slide.addText(who, { x: 0.6, y: 6.3, w: 12, h: 0.5, fontSize: 16, color: "94A3B8", fontFace: FONT });
      return;
    }
    heading(slide, s.title);
    if (s.kind === "ask") {
      s.tiles.forEach((tile, i) => {
        const x = 0.5 + i * 3.1;
        slide.addShape(pptx.ShapeType.rect, { x, y: 1.4, w: 2.9, h: 1.4, fill: { color: LIGHT }, line: { color: "E2E8F0" } });
        slide.addText(tile.value, { x, y: 1.5, w: 2.9, h: 0.8, fontSize: 30, bold: true, color: NAVY, fontFace: FONT, align: "center" });
        slide.addText(tile.label, { x, y: 2.3, w: 2.9, h: 0.4, fontSize: 13, color: GREY, fontFace: FONT, align: "center" });
      });
      bullets(slide, s.bullets, 3.2, 3.6);
    } else if (s.kind === "recs") {
      table(slide, s.columns, s.rows, [3.1, 3.6, 3.6, 2.0]);
    } else if (s.kind === "evidence") {
      table(slide, s.columns, s.rows, [3.2, 2.6, 1.0, 1.9, 2.0, 1.6]);
    } else if (s.kind === "context") {
      table(slide, s.columns, s.rows, [3.0, 1.8, 1.8, 1.6, 1.5, 2.6]);
      if (s.note) slide.addText(s.note, { x: 0.5, y: 6.3, w: 12.3, h: 0.5, fontSize: 12, italic: true, color: GREY, fontFace: FONT });
    } else if (s.kind === "groups") {
      table(slide, s.columns, s.rows, [5.4, 2.3, 2.3, 2.3]);
    } else if (s.kind === "range") {
      table(slide, s.columns, s.rows, [7.8, 4.5]);
      if (s.note) slide.addText(s.note, { x: 0.5, y: 5.2, w: 12.3, h: 0.8, fontSize: 18, color: NAVY, fontFace: FONT });
    } else {
      bullets(slide, s.bullets);
    }
    footer(slide, idx + 1);
  });
}

export async function downloadPack(slides, options, fileName) {
  const PptxGenJS = await loadPptxGen();
  const pptx = new PptxGenJS();
  renderPack(pptx, slides, options);
  await pptx.writeFile({ fileName: `${(fileName || "assortment-recommendation").replace(/[^\w.-]+/g, "_")}.pptx` });
}

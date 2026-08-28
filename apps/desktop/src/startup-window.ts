const STARTUP_CSP = [
  "default-src 'none'",
  'img-src data:',
  "style-src 'unsafe-inline'",
].join('; ')

/** Render the first visible installed-app surface while the Agent Host boots. */
export function desktopStartupDocument(logoDataUrl: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${STARTUP_CSP}">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>世界线正在启动</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      display: grid;
      place-items: center;
      color: #26344a;
      background:
        radial-gradient(circle at 20% 15%, rgba(153, 220, 255, .42), transparent 40%),
        radial-gradient(circle at 82% 20%, rgba(255, 174, 211, .38), transparent 42%),
        linear-gradient(145deg, #f8fcff, #fff9fd);
    }
    main { display: grid; width: min(390px, calc(100vw - 56px)); justify-items: center; gap: 14px; padding: 34px; text-align: center; }
    img {
      width: 112px;
      height: 112px;
      border-radius: 28px;
      object-fit: cover;
      filter: drop-shadow(0 18px 30px rgba(89, 123, 172, .24));
    }
    h1 { margin: 4px 0 0; font-size: 26px; letter-spacing: .08em; }
    p { margin: 0; color: #718098; font-size: 14px; }
    .stage {
      display: grid;
      width: 100%;
      gap: 8px;
      margin-top: 3px;
      padding: 13px 15px;
      border: 1px solid rgba(133, 178, 217, .28);
      border-radius: 12px;
      background: rgba(255, 255, 255, .56);
      box-shadow: 0 10px 30px rgba(67, 104, 145, .08);
      text-align: left;
    }
    .stage header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .stage strong { color: #40536e; font-size: 12px; font-weight: 600; }
    .stage small { color: #8a98aa; font-size: 11px; }
    .track { height: 5px; overflow: hidden; border-radius: 999px; background: rgba(120, 191, 240, .18); }
    .track i { display: block; width: 18%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #72bdf0, #ad8ef2); transition: width .35s ease; }
    .progress { display: flex; gap: 7px; margin-top: 6px; }
    .progress i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #78bff0;
      animation: pulse 1.2s ease-in-out infinite;
    }
    .progress i:nth-child(2) { animation-delay: .15s; }
    .progress i:nth-child(3) { animation-delay: .3s; }
    @keyframes pulse { 0%, 70%, 100% { opacity: .28; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-5px); } }
  </style>
</head>
<body>
  <main>
    <img src="${logoDataUrl}" alt="世界线 Logo">
    <h1>世界线</h1>
    <p id="startup-detail">正在初始化桌面安全环境，请稍候…</p>
    <section class="stage" aria-live="polite" aria-atomic="true">
      <header><strong id="startup-stage">准备桌面组件</strong><small id="startup-step">步骤 1 / 4</small></header>
      <div class="track" role="progressbar" aria-label="启动进度" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"><i id="startup-fill"></i></div>
    </section>
    <div class="progress" role="progressbar" aria-label="正在启动"><i></i><i></i><i></i></div>
  </main>
</body>
</html>`
}

export interface DesktopStartupStage {
  readonly step: number
  readonly title: string
  readonly detail: string
}

/** Build a bounded DOM update for the trusted, self-contained startup document. */
export function desktopStartupStageScript(stage: DesktopStartupStage): string {
  const step = Math.max(1, Math.min(4, Math.round(stage.step)))
  return `(() => {
    const title = document.getElementById('startup-stage');
    const detail = document.getElementById('startup-detail');
    const label = document.getElementById('startup-step');
    const fill = document.getElementById('startup-fill');
    const track = fill?.parentElement;
    if (title) title.textContent = ${JSON.stringify(stage.title)};
    if (detail) detail.textContent = ${JSON.stringify(stage.detail)};
    if (label) label.textContent = ${JSON.stringify(`步骤 ${step} / 4`)};
    if (fill) fill.style.width = ${JSON.stringify(`${step * 25}%`)};
    if (track) track.setAttribute('aria-valuenow', ${JSON.stringify(String(step))});
  })()`
}

export function desktopStartupDataUrl(logoPng: Uint8Array): string {
  const logo = `data:image/png;base64,${Buffer.from(logoPng).toString('base64')}`
  return `data:text/html;base64,${Buffer.from(desktopStartupDocument(logo)).toString('base64')}`
}

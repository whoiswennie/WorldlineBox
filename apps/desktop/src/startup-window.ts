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
    main { display: grid; justify-items: center; gap: 16px; padding: 40px; text-align: center; }
    img {
      width: 112px;
      height: 112px;
      border-radius: 28px;
      object-fit: cover;
      filter: drop-shadow(0 18px 30px rgba(89, 123, 172, .24));
    }
    h1 { margin: 4px 0 0; font-size: 26px; letter-spacing: .08em; }
    p { margin: 0; color: #718098; font-size: 14px; }
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
    <p>正在启动 Agent 与虚拟伙伴运行时，请稍候…</p>
    <div class="progress" role="progressbar" aria-label="正在启动"><i></i><i></i><i></i></div>
  </main>
</body>
</html>`
}

export function desktopStartupDataUrl(logoPng: Uint8Array): string {
  const logo = `data:image/png;base64,${Buffer.from(logoPng).toString('base64')}`
  return `data:text/html;base64,${Buffer.from(desktopStartupDocument(logo)).toString('base64')}`
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  })[character]);
}

export function renderReportHtml(report) {
  const reportJson = escapeJsonForHtml(report);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EmbeddingGemma 2 experiment</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
    body { margin: 2rem auto; max-width: 1200px; padding: 0 1rem; }
    header, section { margin-block: 1.5rem; }
    .controls { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; }
    label { display: grid; gap: .35rem; }
    .profiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .75rem; }
    .profile, .query { border: 1px solid currentColor; border-radius: .5rem; padding: .75rem; }
    .profile h3, .query h2 { margin: 0 0 .5rem; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; min-width: 44rem; width: 100%; }
    th, td { border: 1px solid currentColor; padding: .5rem; text-align: left; vertical-align: top; }
    td figure { margin: 0; min-width: 7rem; }
    td img { display: block; height: 7rem; max-width: 9rem; object-fit: contain; }
    figcaption { overflow-wrap: anywhere; }
    .muted { color: GrayText; }
    #status { min-height: 1.5em; }
  </style>
</head>
<body>
  <header>
    <h1>EmbeddingGemma 2 image retrieval</h1>
    <p id="run-summary"></p>
    <div class="profiles" id="profiles"></div>
    <div class="controls">
      <label>Choose the original sample folder<input id="folder" type="file" webkitdirectory directory multiple></label>
      <label>Choose its local sample-map.json<input id="map" type="file" accept="application/json,.json"></label>
      <label>Optional query image<input id="query-image" type="file" accept="image/jpeg,image/png,image/webp"></label>
    </div>
    <p id="status" class="muted">Choose the sample folder and matching sample-map.json to show thumbnails. Files stay in this browser tab.</p>
  </header>
  <main id="queries"></main>
  <script type="application/json" id="report-data">${reportJson}</script>
  <script>
    const report = JSON.parse(document.getElementById('report-data').textContent);
    const folderInput = document.getElementById('folder');
    const mapInput = document.getElementById('map');
    const queryInput = document.getElementById('query-image');
    const status = document.getElementById('status');
    const urls = new Map();
    let sampleMap = null;
    let sampleFiles = new Map();
    let queryImageUrl = null;

    function make(tag, text, className) {
      const element = document.createElement(tag);
      if (text !== undefined && text !== null) element.textContent = String(text);
      if (className) element.className = className;
      return element;
    }

    function fileUrl(file) {
      if (!file) return null;
      if (!urls.has(file)) urls.set(file, URL.createObjectURL(file));
      return urls.get(file);
    }

    function render() {
      const profileList = document.getElementById('profiles');
      profileList.replaceChildren();
      for (const profile of report.profiles) {
        const card = make('div', undefined, 'profile');
        card.append(make('h3', profile.label || profile.id));
        card.append(make('div', 'Status: ' + profile.status));
        if (profile.timingsMs) card.append(make('div', 'Startup: ' + (profile.timingsMs.startup ?? '—') + ' ms · Images: ' + (profile.timingsMs.imageEncodingTotal ?? '—') + ' ms'));
        if (profile.skippedImages?.length) card.append(make('div', 'Skipped images: ' + profile.skippedImages.length));
        if (profile.error) card.append(make('div', profile.error.code + ': ' + profile.error.message));
        profileList.append(card);
      }

      const queryList = document.getElementById('queries');
      queryList.replaceChildren();
      const queries = new Map();
      for (const profile of report.profiles) {
        for (const query of profile.queries || []) {
          const key = query.queryId || query.type;
          if (!queries.has(key)) queries.set(key, { query, byProfile: new Map() });
          queries.get(key).byProfile.set(profile.id, query);
        }
      }

      for (const [queryId, group] of queries) {
        const section = make('section', undefined, 'query');
        const mappedText = sampleMap?.textQueries?.find((item) => item.id === queryId)?.text;
        const heading = group.query.type === 'image' ? 'Image query' : 'Text query';
        section.append(make('h2', heading + ' · ' + (mappedText || queryId)));
        if (group.query.type === 'image' && queryImageUrl) {
          const queryPreview = make('img');
          queryPreview.src = queryImageUrl;
          queryPreview.alt = 'Selected query image';
          queryPreview.height = 112;
          section.append(queryPreview);
        }
        const wrap = make('div', undefined, 'table-wrap');
        const table = make('table');
        const head = make('thead');
        const headerRow = make('tr');
        headerRow.append(make('th', 'Rank'));
        for (const profile of report.profiles) headerRow.append(make('th', profile.id + ' · ' + profile.status));
        head.append(headerRow);
        table.append(head);
        const body = make('tbody');
        const maxResults = Math.max(0, ...[...group.byProfile.values()].map((query) => query.results?.length || 0));
        for (let rank = 0; rank < maxResults; rank += 1) {
          const row = make('tr');
          row.append(make('th', rank + 1));
          for (const profile of report.profiles) {
            const cell = make('td');
            const result = group.byProfile.get(profile.id)?.results?.[rank];
            if (result) {
              const figure = make('figure');
              const file = sampleFiles.get(result.filename);
              if (file) {
                const anchor = make('a');
                anchor.href = fileUrl(file);
                anchor.target = '_blank';
                anchor.rel = 'noopener';
                const image = make('img');
                image.src = fileUrl(file);
                image.alt = result.filename;
                anchor.append(image);
                figure.append(anchor);
              } else {
                figure.append(make('div', 'Thumbnail unavailable', 'muted'));
              }
              figure.append(make('figcaption', result.filename + ' · ' + Number(result.score).toFixed(4)));
              cell.append(figure);
            } else {
              cell.append(make('span', '—', 'muted'));
            }
            row.append(cell);
          }
          body.append(row);
        }
        table.append(body);
        wrap.append(table);
        section.append(wrap);
        queryList.append(section);
      }
    }

    document.getElementById('run-summary').textContent = 'Run ' + report.runId + ' · ' + report.status + ' · ' + report.dimensions + ' dimensions';
    folderInput.addEventListener('change', () => {
      const files = [...folderInput.files].filter((file) => file.webkitRelativePath.split('/').length === 2);
      if (!sampleMap) {
        status.textContent = 'Now choose the matching sample-map.json.';
        return;
      }
      sampleFiles = new Map(sampleMap.samples.map((sample) => [sample.id, files.find((file) => file.name === sample.relativeFilename)]).filter((entry) => entry[1]));
      status.textContent = 'Matched ' + sampleFiles.size + ' of ' + sampleMap.samples.length + ' sample images. Files remain in this browser tab.';
      render();
    });
    mapInput.addEventListener('change', async () => {
      try {
        sampleMap = JSON.parse(await mapInput.files[0].text());
        const files = [...folderInput.files].filter((file) => file.webkitRelativePath.split('/').length === 2);
        sampleFiles = new Map(sampleMap.samples.map((sample) => [sample.id, files.find((file) => file.name === sample.relativeFilename)]).filter((entry) => entry[1]));
        status.textContent = 'Matched ' + sampleFiles.size + ' of ' + sampleMap.samples.length + ' sample images. Files remain in this browser tab.';
        render();
      } catch {
        sampleMap = null;
        sampleFiles = new Map();
        status.textContent = 'Could not read this sample map. Choose the sample-map.json created with this report.';
        render();
      }
    });
    queryInput.addEventListener('change', () => {
      if (queryImageUrl) URL.revokeObjectURL(queryImageUrl);
      queryImageUrl = queryInput.files[0] ? URL.createObjectURL(queryInput.files[0]) : null;
      render();
    });
    window.addEventListener('pagehide', () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      if (queryImageUrl) URL.revokeObjectURL(queryImageUrl);
    }, { once: true });
    render();
  </script>
</body>
</html>
`;
}

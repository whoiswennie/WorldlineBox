import { useEffect, useId, useState } from 'react';
import DOMPurify from 'dompurify';
import { MessageCodeBlock } from './MessageCodeBlock';
let rendering = Promise.resolve();

/** Serialize Mermaid's shared parser, then allow only sanitized local SVG. */
export function MessageDiagram({ source }: { source: string }) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    let current = true;
    rendering = rendering.catch(() => undefined).then(async () => {
      try {
        if (source.length > 16000) throw new Error('Diagram size limit');
        const { default: mermaid } = await import('mermaid');
        if (!current) return;
        const dark = document.documentElement.dataset.theme === 'dark';
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', suppressErrorRendering: true,
          maxTextSize: 16000, maxEdges: 500, htmlLabels: false, flowchart: { htmlLabels: false },
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'themeCSS'] });
        const result = await mermaid.render('companion-diagram-' + id, source);
        const safe = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'image'] });
        const diagramDoc = new DOMParser().parseFromString(safe, 'image/svg+xml');
        for (const element of diagramDoc.querySelectorAll('*')) {
          for (const attribute of [...element.attributes]) if (/^(?:href|xlink:href)$/i.test(attribute.name) && !attribute.value.startsWith('#')) element.removeAttribute(attribute.name);
          if (/url\(\s*['"]?(?!#)/i.test(element.getAttribute('style') ?? '')) element.removeAttribute('style');
          if (element.localName === 'style' && /@import|url\(\s*['"]?(?!#)/i.test(element.textContent ?? '')) element.remove();
        }
        if (current) { setSvg(new XMLSerializer().serializeToString(diagramDoc.documentElement)); setError(''); }
      } catch { if (current) { setError('图表暂时无法渲染，可查看源码。'); setSvg(''); } }
    });
    return () => { current = false; };
  }, [source, id]);
  return <figure className="companions-diagram"><figcaption><span>Mermaid 图表</span><button type="button" onClick={() => setShowSource(!showSource)}>{showSource ? '收起源码' : '查看源码'}</button></figcaption>
    {svg ? <div className="companions-diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="companions-subtle">{error || '正在绘制图表…'}</p>}
    {(showSource || error) && <MessageCodeBlock code={source} language="mermaid" />}
  </figure>;
}

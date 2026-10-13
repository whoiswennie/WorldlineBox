import { useId, useMemo, useRef } from 'react';
import { Icon } from '../Icons';
import { useT } from '../i18n';
import { PluginReadmeView } from '../PluginReadmeView';
import { parseReleaseNotes } from './release-notes';

export function ReleaseNotes({ notes, releaseUrl, onOpenUrl }: {
  readonly notes: string;
  readonly releaseUrl: string;
  readonly onOpenUrl: (url: string) => void;
}) {
  const t = useT();
  const idPrefix = useId();
  const body = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => parseReleaseNotes(notes, releaseUrl, idPrefix), [notes, releaseUrl, idPrefix]);
  const first = blocks[0];
  const navigation = first?.type === 'paragraph' && first.children.some(node => node.type === 'link')
    && first.children.every(node => node.type === 'link' ? node.href.startsWith('#') : node.type === 'text' && /^[\s|·]*$/.test(node.value))
    ? first.children.filter(node => node.type === 'link') : [];
  const content = navigation.length ? blocks.slice(1) : blocks;

  const openLink = (href: string) => {
    if (!href.startsWith('#')) { onOpenUrl(href); return; }
    const panel = body.current;
    const target = panel && [...panel.querySelectorAll<HTMLElement>('[id]')].find(node => node.id === `${idPrefix}-${href.slice(1)}`);
    if (panel && target) panel.scrollTo({
      top: panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 20,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };

  return <details className="launcher-version-notes">
    <summary><Icon name="chevron-right" size={14} /><span>{t('launcher.releaseNotes')}</span></summary>
    <div className="launcher-release-notes">
      {navigation.length ? <nav aria-label={t('launcher.releaseNotes')} className="launcher-release-notes-navigation">{navigation.map(node =>
        <button key={node.href} onClick={() => openLink(node.href)} type="button">{node.children.map(child => child.type === 'text' ? child.value : '').join('')}</button>
      )}</nav> : null}
      <div aria-label={t('launcher.releaseNotes')} className="launcher-release-notes-body" ref={body} tabIndex={0}>
        <PluginReadmeView blocks={content} empty="" imageLabel={t('settings.pluginCommunityReadmeImage')} onOpenUrl={openLink} />
      </div>
    </div>
  </details>;
}

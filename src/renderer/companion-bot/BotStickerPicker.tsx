import { useEffect, useRef, useState } from 'react';
import type { BotMediaRef, BotStickerPack, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';
import './bot-expression.css';

const emojiGroups = [
  { zh: '笑脸与心情', en: 'Faces & feelings', items: '😊 😄 🥰 😎 🤔 🥺 😭 😂 😁 😆 😅 🤣 🙂 🙃 😉 😌 😍 😘 😗 😋 😛 😜 🤪 🤨 🧐 🤓 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤭 🫢 🫣 🤫 🫡 🤥 😶 😐 😑 🙄 😬 😮 😯 😲 🥱 😴 🤤 😵 🤐 🤢 🤮 🤧 😷 🤒 🤕' },
  { zh: '手势与喜爱', en: 'Gestures & love', items: '👍 👎 👏 🙌 🤝 👋 🤚 ✋ 👌 ✌️ 🤞 🤟 🤘 👈 👉 👆 👇 ☝️ 💪 🫶 🙏 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💕 💞 💓 💗 💖 💘 💝 ✨ 🎉 🎊 💯 🔥 ⭐' },
  { zh: '生活与自然', en: 'Life & nature', items: '🐳 🐟 🐱 🐶 🐻 🐼 🐰 🦊 🐸 🐧 🐤 🦋 🍚 ☕ 🍵 🥤 🍟 🍔 🍕 🍜 🍰 🍪 🍫 🍓 🍒 🍉 🍎 🌙 ☀️ 🌈 🌊 🌻 🌸 🍀 🌿 🌲 🎵 🎮 📚 💻 🎨 🎁' },
] as const;
const recentKey = 'worldlinebox.expression-recents.v1';
function readRecentEmoji(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 12).slice(0, 20) : []; } catch { return []; }
}

export function BotStickerPicker({ api, conversationId, locale, onSelect, initialTab = 'stickers', onEmoji, onClose, onTabChange, sendDisabled = false }: {
  api?: WorldlineBoxBotMediaApi; conversationId: string; locale: 'zh-CN' | 'en'; onSelect(media: BotMediaRef): void;
  initialTab?: 'emoji' | 'stickers'; onEmoji?(emoji: string): void; onClose?(): void;
  onTabChange?(tab: 'emoji' | 'stickers'): void; sendDisabled?: boolean;
}) {
  const zh = locale === 'zh-CN';
  const [packs, setPacks] = useState<BotStickerPack[]>([]), [selected, setSelected] = useState(''), [stickers, setStickers] = useState<BotMediaRef[]>([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [query, setQuery] = useState('');
  const [tab, setTab] = useState(initialTab), [recent, setRecent] = useState(readRecentEmoji);
  const [searchOpen, setSearchOpen] = useState(false);
  const generation = useRef(0), alive = useRef(true);
  const changeTab = (value: 'emoji' | 'stickers') => { setTab(value); onTabChange?.(value); };
  const choose = async (id: string, switchTab = true) => {
    if (!api) return;
    if (switchTab) changeTab('stickers');
    const token = ++generation.current; setSelected(id); setBusy(true); setError(''); setStickers([]);
    try {
      const result = await api.request({ type: 'stickers.list', conversationId, packId: id });
      if (!alive.current || token !== generation.current) return;
      if (result.ok) setStickers(result.media ?? []); else setError(result.error ?? (zh ? '读取表情包失败' : 'Could not load stickers'));
    } catch { if (alive.current && token === generation.current) setError(zh ? '读取表情包失败' : 'Could not load stickers'); }
    finally { if (alive.current && token === generation.current) setBusy(false); }
  };
  const load = async (preferred = '') => {
    if (!api) { setBusy(false); return; }
    const token = ++generation.current; setBusy(true); setError('');
    try {
      const result = await api.request({ type: 'packs.list', conversationId });
      if (!alive.current || token !== generation.current) return;
      if (!result.ok) { setError(result.error ?? (zh ? '读取表情包失败' : 'Could not load stickers')); setBusy(false); return; }
      const entries = result.packs ?? []; setPacks(entries);
      const id = entries.find(pack => pack.id === preferred)?.id ?? entries[0]?.id;
      if (id) await choose(id, !!preferred); else setBusy(false);
    } catch { if (alive.current && token === generation.current) { setError(zh ? '读取表情包失败' : 'Could not load stickers'); setBusy(false); } }
  };
  useEffect(() => {
    alive.current = true; queueMicrotask(() => { if (alive.current) void load(); });
    return () => { alive.current = false; };
    // A selected conversation owns this keyed picker for its whole lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const importPack = async () => {
    if (!api) return;
    setBusy(true); setError('');
    try {
      const result = await api.request({ type: 'pack.pick', conversationId });
      if (!alive.current) return;
      if (result.ok && !result.cancelled) { await load(result.pack?.id); if (alive.current) changeTab('stickers'); } else { if (!result.ok) setError(result.error ?? (zh ? '导入失败' : 'Import failed')); setBusy(false); }
    } catch { if (alive.current) { setError(zh ? '导入失败' : 'Import failed'); setBusy(false); } }
  };
  const needle = query.trim().toLocaleLowerCase();
  const visible = stickers.filter(item => `${item.name} ${item.originalName ?? ''} ${item.description ?? ''} ${item.tags?.join(' ') ?? ''}`.toLocaleLowerCase().includes(needle));
  const selectEmoji = (emoji: string) => {
    const next = [emoji, ...recent.filter(item => item !== emoji)].slice(0, 20); setRecent(next);
    try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* Emoji insertion remains available without browser storage. */ }
    onEmoji?.(emoji);
  };
  return <section className="bot-sticker-picker bot-expression-picker" aria-label={zh ? '表情面板' : 'Expressions'}>
    <header><div className="bot-expression-tabs" role="tablist" aria-label={zh ? '表情类型' : 'Expression type'}>
      <button role="tab" type="button" aria-label={zh ? '常用表情' : 'Common emoji'} aria-selected={tab === 'emoji'} onClick={() => changeTab('emoji')}>{zh ? '表情' : 'Emoji'}</button>
      {api && <button role="tab" type="button" aria-label={zh ? '表情包' : 'Stickers'} aria-selected={tab === 'stickers'} onClick={() => changeTab('stickers')}>{zh ? '表情包' : 'Stickers'}</button>}
    </div>{onClose && <button type="button" aria-label={zh ? '关闭表情面板' : 'Close expressions'} onClick={onClose}>×</button>}</header>
    {tab === 'stickers' && <div className="bot-expression-context">{packs.find(pack => pack.id === selected)?.name ?? (zh ? '选择表情包' : 'Choose a pack')}<span>{visible.length}{zh ? ' 个表情' : ' stickers'}</span></div>}
    {tab === 'stickers' && searchOpen && <label className="bot-expression-search"><BotIcon name="search" /><input autoFocus aria-label={zh ? '搜索表情' : 'Search stickers'} placeholder={zh ? '搜索表情' : 'Search stickers'} value={query} onChange={event => setQuery(event.target.value)} /><button type="button" aria-label={zh ? '收起搜索' : 'Hide search'} onClick={() => { setSearchOpen(false); setQuery(''); }}>×</button></label>}
    {tab === 'emoji' ? <div className="bot-expression-scroll" role="group" aria-label={zh ? '常用表情' : 'Common emoji'}>
      {[...(recent.length ? [{ zh: '最近使用', en: 'Recently used', items: recent.join(' ') }] : []), ...emojiGroups].map(group => <section key={group.en}><h4>{zh ? group.zh : group.en}</h4><div className="bot-expression-emoji-grid">{group.items.split(' ').map(emoji => <button key={emoji} type="button" title={emoji} aria-label={emoji} onMouseDown={event => event.preventDefault()} onClick={() => selectEmoji(emoji)}>{emoji}</button>)}</div></section>)}
    </div> : busy ? <p role="status">{zh ? '正在加载…' : 'Loading…'}</p> : error ? <div className="bot-expression-error" role="alert"><p>{error}</p><button type="button" onClick={() => void load(selected)}>{zh ? '重试' : 'Retry'}</button></div> : <div className="bot-sticker-grid">
      {visible.map(item => <StickerButton key={item.id} media={item} onSelect={onSelect} disabled={sendDisabled} />)}{!visible.length && <p>{zh ? '没有匹配的表情' : 'No matching stickers'}</p>}
    </div>}
    <footer>{api && <button type="button" aria-label={zh ? '搜索表情包' : 'Search sticker pack'} title={zh ? '搜索表情包' : 'Search sticker pack'} aria-pressed={searchOpen && tab === 'stickers'} onClick={() => { changeTab('stickers'); setSearchOpen(value => !value); setQuery(''); }}><BotIcon name="search" /></button>}
      <nav aria-label={zh ? '表情包分类' : 'Sticker packs'}>{packs.map(pack => <button key={pack.id} type="button" aria-label={pack.name} title={`${pack.name} · ${pack.count}`} aria-pressed={tab === 'stickers' && selected === pack.id} onClick={() => void choose(pack.id)}>{pack.cover ? <img src={pack.cover.previewUrl ?? pack.cover.url} alt="" /> : <BotIcon name="sticker" />}<span className="bot-sr-only">{pack.name}</span></button>)}</nav>
      {api && <button className="bot-expression-import" type="button" disabled={busy} aria-label={zh ? '导入表情包' : 'Import pack'} title={zh ? '导入表情包' : 'Import pack'} onClick={() => void importPack()}><BotIcon name="plus" /></button>}
    </footer>
  </section>;
}
function StickerButton({ media, onSelect, disabled }: { media: BotMediaRef; onSelect(media: BotMediaRef): void; disabled?: boolean }) {
  const [playing, setPlaying] = useState(false);
  return <button type="button" disabled={disabled} title={[media.originalName ?? media.name, media.description].filter(Boolean).join('\n')} aria-label={media.name} onPointerEnter={() => setPlaying(true)} onPointerLeave={() => setPlaying(false)} onFocus={() => setPlaying(true)} onBlur={() => setPlaying(false)} onClick={() => onSelect(media)}>
    <img src={playing ? media.url : media.previewUrl ?? media.url} alt={media.name} loading="lazy" draggable={false} /><span className="bot-sticker-caption">{media.originalName?.replace(/\.[^.]+$/, '') ?? media.name}</span>
  </button>;
}

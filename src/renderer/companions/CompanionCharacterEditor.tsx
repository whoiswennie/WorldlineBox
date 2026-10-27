import { parseCharacterDocument, replaceCharacterField, appendCharacterSection } from '../../shared/companion-character-document';
import { Icon } from '../Icons';
import { useState } from 'react';
import { standardizeCompanionCharacter } from '../../shared/companion-character';
import './companion-character-editor.css';

export function CompanionCharacterEditor({ value, name, disabled, onChange }: {
  value: string; name: string; disabled?: boolean; onChange(value: string): void;
}) {
  const sections = parseCharacterDocument(value);
  const [mode, setMode] = useState<'fields' | 'text'>(sections.length ? 'fields' : 'text');
  const [sectionIndex, setSectionIndex] = useState(0), [managing, setManaging] = useState(false);
  const [tooLong, setTooLong] = useState(false);
  const selected = Math.min(sectionIndex, Math.max(0, sections.length - 1));
  const update = (next: string) => { setTooLong(next.length > 12000); if (next.length <= 12000) onChange(next); };
  const addSection = () => {
    const title = '新章节' + (sections.some(section => section.title === '新章节') ? sections.length + 1 : '');
    update(appendCharacterSection(value, title)); setSectionIndex(sections.length); setManaging(true); setMode('fields');
  };
  return <div className="companions-character-editor">
    <div className="companions-character-toolbar"><strong>角色人设</strong><div>
      <button type="button" className="companion-secondary-button" disabled={disabled} onClick={() => setMode(mode === 'fields' ? 'text' : 'fields')}>{mode === 'fields' ? '编辑完整文本' : '按字段编辑'}</button>
      {mode === 'fields' && <button type="button" className="companion-secondary-button" aria-pressed={managing} disabled={disabled} onClick={() => setManaging(!managing)}>{managing ? '完成字段管理' : '管理字段'}</button>}
    </div></div>
    <p className="companions-subtle">章节和字段来自源文本，可新增、改名或删除。保存后，伙伴会使用当前完整设定。</p>
    {mode === 'text' ? <label>人设<textarea required rows={16} maxLength={12000} disabled={disabled} value={value} onChange={event => update(event.target.value)} placeholder="用【章节名】或 Markdown 标题划分章节，用“字段名：内容”填写设定；也可以直接写自由文本。" /></label> : <>
      <nav className="character-section-tabs" aria-label="人设章节">{sections.map((section, index) => <button type="button" key={index} aria-pressed={selected === index} onClick={() => setSectionIndex(index)}>{section.title}<small>{section.fields.length} 项</small></button>)}<button type="button" aria-label="添加人设章节" disabled={disabled} onClick={addSection}><Icon name="plus" />章节</button></nav>
      {sections.map((section, index) => <fieldset key={index} hidden={selected !== index} disabled={disabled}>
        <legend>{section.title}</legend>
        {managing && <div className="character-section-management"><label>章节名称<input value={section.title} onChange={event => { const title = event.target.value.replace(/[【】\r\n]/gu, ''); if (title.trim()) update(value.slice(0, section.start) + '【' + title + '】\n' + value.slice(section.headingEnd)); }} /></label><button type="button" className="companion-text-danger" onClick={() => { update(value.slice(0, section.start) + value.slice(section.end)); setSectionIndex(Math.max(0, index - 1)); }}>删除本章</button></div>}
        {section.intro.trim() && <label className="is-wide">章节正文<textarea rows={4} value={section.intro.trimEnd()} onChange={event => update(value.slice(0, section.headingEnd) + event.target.value + '\n' + value.slice(section.fields[0]?.start ?? section.end))} /></label>}
        {section.fields.map((field, fieldIndex) => <label key={fieldIndex} className={field.value.length > 220 ? 'is-wide' : ''}>{managing ? <span className="character-field-management"><input aria-label={'字段名称 ' + field.label} value={field.label} onChange={event => update(replaceCharacterField(value, field, event.target.value, field.value))} /><button type="button" aria-label={'删除字段 ' + field.label} onClick={() => update(value.slice(0, field.start) + value.slice(field.end))}><Icon name="close" /></button></span> : field.label}
          <textarea aria-label={field.label} rows={field.value.length > 220 ? 5 : 3} value={field.value} onChange={event => update(replaceCharacterField(value, field, field.label, event.target.value))} />
        </label>)}
        {managing && <button type="button" className="character-add-field" onClick={() => update(value.slice(0, section.end) + (value.slice(0, section.end).endsWith('\n') ? '' : '\n') + '新字段' + (section.fields.some(field => field.label === '新字段') ? section.fields.length + 1 : '') + '：\n' + value.slice(section.end))}><Icon name="plus" />添加字段</button>}
      </fieldset>)}
      {!sections.length && <div className="character-empty-fields"><p>当前设定是自由文本。可以添加章节，也可以使用起始模板后继续自定义。</p><button type="button" disabled={disabled} onClick={addSection}>添加章节</button><button type="button" disabled={disabled} onClick={() => update(standardizeCompanionCharacter(value, name))}>使用起始模板</button></div>}
    </>}
    <p className="companions-subtle">{value.length} / 12000 字</p>
    {tooLong && <p role="alert">人设最多 12000 字，本次输入未保存，请缩短后重试。</p>}
  </div>;
}

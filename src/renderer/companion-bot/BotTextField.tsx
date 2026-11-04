import { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import './bot-text-field.css';

export interface BotTextFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'children'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  actions?: ReactNode;
  showCount?: boolean;
  minRows?: number;
  maxRows?: number;
  autoSize?: boolean;
  /** className styles the field; this class styles its native textarea. */
  textareaClassName?: string;
}

const present = (value: ReactNode) => value !== undefined && value !== null && value !== false && value !== '';
const rowCount = (value: number | undefined, fallback: number) => Number.isFinite(value) ? Math.min(40, Math.max(1, Math.floor(value!))) : fallback;
const textLength = (value: TextareaHTMLAttributes<HTMLTextAreaElement>['value']) => String(value ?? '').length;

/** Native editing owns composition, selection, clipboard and undo. This
 * component changes only presentation and optionally measures bounded height. */
export const BotTextField = memo(forwardRef<HTMLTextAreaElement, BotTextFieldProps>(function BotTextField({
  label, hint, error, actions, showCount = false, minRows, maxRows, autoSize = false, className, textareaClassName,
  id, rows, value, defaultValue, disabled, style, onChange, ...attributes
}, forwardedRef) {
  const generatedId = useId(), fieldId = id ?? `bot-field-${generatedId}`;
  const hintId = `${fieldId}-hint`, errorId = `${fieldId}-error`;
  const element = useRef<HTMLTextAreaElement>(null), frame = useRef<number | null>(null);
  const [uncontrolledCount, setUncontrolledCount] = useState(() => textLength(defaultValue));
  const minimum = rowCount(minRows ?? rows, 3), maximum = Math.max(minimum, rowCount(maxRows, 8));
  const hasHint = present(hint), hasError = present(error), hasActions = present(actions);
  const controlled = value !== undefined, count = controlled ? textLength(value) : uncontrolledCount;
  useImperativeHandle(forwardedRef, () => element.current!, []);

  const cancelFrame = useCallback(() => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
  }, []);
  const scheduleMeasure = useCallback(() => {
    if ((!autoSize && (!showCount || controlled)) || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const textarea = element.current; if (!textarea) return;
      if (showCount && !controlled) setUncontrolledCount(textarea.value.length);
      if (!autoSize) return;
      const computed = getComputedStyle(textarea);
      const pixels = (property: string) => Number.parseFloat(computed.getPropertyValue(property)) || 0;
      const lineHeight = pixels('line-height') || 22.4;
      const padding = pixels('padding-top') + pixels('padding-bottom');
      const border = pixels('border-top-width') + pixels('border-bottom-width');
      const minHeight = minimum * lineHeight + padding + border, maxHeight = maximum * lineHeight + padding + border;
      textarea.style.height = '0px';
      const contentHeight = textarea.scrollHeight + border;
      textarea.style.minHeight = `${minHeight}px`; textarea.style.maxHeight = `${maxHeight}px`;
      textarea.style.height = `${Math.max(minHeight, Math.min(maxHeight, contentHeight))}px`;
      textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    });
  }, [autoSize, showCount, controlled, minimum, maximum]);

  useEffect(() => {
    if (!autoSize && element.current) {
      // Restore caller styles when switching out of auto height.
      element.current.style.height = style?.height === undefined ? '' : typeof style.height === 'number' ? `${style.height}px` : style.height;
      element.current.style.minHeight = style?.minHeight === undefined ? '' : typeof style.minHeight === 'number' ? `${style.minHeight}px` : style.minHeight;
      element.current.style.maxHeight = style?.maxHeight === undefined ? '' : typeof style.maxHeight === 'number' ? `${style.maxHeight}px` : style.maxHeight;
      element.current.style.overflowY = style?.overflowY ?? '';
    }
    scheduleMeasure();
    return cancelFrame;
  }, [scheduleMeasure, cancelFrame, autoSize, value, defaultValue, style?.height, style?.minHeight, style?.maxHeight, style?.overflowY]);
  useEffect(() => {
    const textarea = element.current;
    if (!textarea || (!autoSize && (!showCount || controlled))) return;
    const form = textarea.form;
    form?.addEventListener('reset', scheduleMeasure);
    if (!autoSize) return () => form?.removeEventListener('reset', scheduleMeasure);
    let width: number | undefined;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && next !== width) { width = next; scheduleMeasure(); }
    });
    observer?.observe(textarea);
    window.addEventListener('resize', scheduleMeasure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', scheduleMeasure); form?.removeEventListener('reset', scheduleMeasure); };
  }, [autoSize, showCount, controlled, scheduleMeasure, attributes.form]);

  const describedBy = [attributes['aria-describedby'], hasHint ? hintId : undefined, hasError ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  return <div className={`bot-text-field${disabled ? ' is-disabled' : ''}${hasError ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
    {present(label) && <label className="bot-text-field__label" htmlFor={fieldId}>{label}</label>}
    <div className="bot-text-field__surface">
      <textarea {...attributes} ref={element} id={fieldId} value={value} defaultValue={defaultValue} disabled={disabled}
        rows={rows ?? minimum} style={style} className={`bot-text-field__control${textareaClassName ? ` ${textareaClassName}` : ''}`}
        aria-describedby={describedBy} aria-invalid={hasError ? true : attributes['aria-invalid']}
        onChange={event => {
          if (showCount && value === undefined) setUncontrolledCount(event.currentTarget.value.length);
          onChange?.(event); scheduleMeasure();
        }} />
      {(showCount || hasActions) && <div className="bot-text-field__footer">
        {hasActions && <div className="bot-text-field__actions">{actions}</div>}
        {showCount && <span className="bot-text-field__count" aria-live="off">{count}{attributes.maxLength !== undefined && attributes.maxLength >= 0 ? ` / ${attributes.maxLength}` : ''}</span>}
      </div>}
    </div>
    {hasHint && <div className="bot-text-field__hint" id={hintId}>{hint}</div>}
    {hasError && <div className="bot-text-field__error" id={errorId} role="alert">{error}</div>}
  </div>;
}));

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { isImeKeyboardEvent } from '../../ime-safe-dismiss';
import { PortaledPopover } from '../../PortaledPopover';
import {
  focusFirstRovingItem,
  handleRovingListKeyDown,
  ROVING_OPTION_SELECTOR,
} from '../../roving-list-keyboard';
import type { UiLayerName } from '../foundation';
import {
  Field,
  getFieldAriaProps,
  getFieldControlClassName,
  getFieldIds,
  useFieldId,
} from './Field';
import { cx } from './cx';

export type SelectOption = {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
};

export type SelectProps = {
  readonly appearance?: 'field' | 'inline';
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly error?: ReactNode;
  readonly id?: string;
  readonly invalid?: boolean;
  readonly label?: ReactNode;
  readonly layer?: Extract<UiLayerName, 'popover' | 'modal' | 'tooltip'>;
  readonly loading?: boolean;
  readonly menuClassName?: string;
  readonly onValueChange?: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: ReactNode;
  readonly required?: boolean;
  readonly value?: string;
  readonly wrapperClassName?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-errormessage'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'aria-labelledby'?: string;
  readonly 'data-hover-tip'?: string;
};

/**
 * Standard dropdown. The closed control follows the field or toolbar chrome.
 * The open list is always `ui-menu-surface`, so every menu uses the same
 * surface, text, hover, and selected colors.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select({
  appearance = 'field',
  autoFocus = false,
  className,
  description,
  disabled = false,
  error,
  id,
  invalid = false,
  label,
  layer = 'popover',
  loading = false,
  menuClassName,
  onValueChange,
  options,
  placeholder,
  required = false,
  value = '',
  wrapperClassName,
  ...ariaRest
}, ref) {
  const controlId = useFieldId(id, 'ui-select');
  const ids = getFieldIds(controlId);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => triggerRef.current!, []);
  const [open, setOpen] = useState(false);
  const hasError = error !== undefined || invalid;
  const isDisabled = disabled || loading;
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? placeholder ?? value;
  const usesTextField = className?.split(/\s+/).includes('text-field') === true;
  const aria = getFieldAriaProps(ids, {
    hasDescription: description !== undefined,
    hasError,
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (rootRef.current?.contains(event.target)) return;
      if (event.target.closest('[data-dimension-filter-popover]')) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    const raf = requestAnimationFrame(() => {
      const list = document.getElementById(listId);
      if (list instanceof HTMLElement) {
        const current = list.querySelector<HTMLElement>(
          `${ROVING_OPTION_SELECTOR}[aria-selected="true"]`,
        );
        if (current) {
          current.focus();
          return;
        }
        focusFirstRovingItem(list, ROVING_OPTION_SELECTOR);
      }
    });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      cancelAnimationFrame(raf);
    };
  }, [listId, open]);

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (isImeKeyboardEvent(event.nativeEvent)) return;
    const result = handleRovingListKeyDown({
      key: event.key,
      container: event.currentTarget,
      itemSelector: ROVING_OPTION_SELECTOR,
    });
    if (!result.handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (result.action === 'escape') setOpen(false);
  }

  function pick(next: string) {
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== value) onValueChange?.(next);
  }

  const control = (
    <div
      className={cx('ui-select', appearance === 'inline' && 'is-inline', wrapperClassName)}
      ref={rootRef}
    >
      <button
        {...aria}
        {...ariaRest}
        aria-busy={loading || undefined}
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-required={required || undefined}
        autoFocus={autoFocus}
        className={appearance === 'inline' || usesTextField
          ? cx(appearance === 'inline' ? 'ui-select-trigger' : 'ui-select-text-field', className)
          : getFieldControlClassName({ className, invalid: hasError, loading })}
        data-value={value}
        disabled={isDisabled}
        id={controlId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (open || isDisabled) return;
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="ui-select-value">{selectedLabel}</span>
      </button>
      {open ? (
        <PortaledPopover
          anchorRef={rootRef}
          className={cx('ui-menu-surface ui-select-menu', menuClassName)}
          id={listId}
          layer={layer}
          onKeyDown={onListKeyDown}
          role="listbox"
        >
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={option.value === value ? 'is-selected' : undefined}
              data-value={option.value}
              disabled={option.disabled}
              key={option.value}
              onClick={() => pick(option.value)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </PortaledPopover>
      ) : null}
    </div>
  );

  return label === undefined && description === undefined && error === undefined ? control : (
    <Field
      className={wrapperClassName}
      description={description}
      error={error}
      htmlFor={controlId}
      label={label}
      required={required}
    >
      {control}
    </Field>
  );
});

export function isSelectValueAvailable(
  value: string,
  options: readonly SelectOption[],
): boolean {
  return options.some((option) => option.value === value && option.disabled !== true);
}

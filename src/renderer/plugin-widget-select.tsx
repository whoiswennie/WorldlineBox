import { Select, type SelectOption } from './ui/primitives/Select';

export type PluginWidgetSelectOption = SelectOption;

export function PluginWidgetSelect({
  description,
  disabled = false,
  id,
  label,
  onValueChange,
  options,
  value,
}: {
  readonly description?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly label?: string;
  readonly onValueChange?: (value: string) => void;
  readonly options: readonly PluginWidgetSelectOption[];
  readonly value: string;
}) {
  return (
    <Select
      className="plugin-widget-select-trigger"
      description={description}
      disabled={disabled}
      id={id}
      label={label}
      layer="tooltip"
      menuClassName="plugin-widget-select-menu"
      onValueChange={onValueChange}
      options={options}
      value={value}
    />
  );
}

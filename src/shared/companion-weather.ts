/** Canonical simulation weather vocabulary, shared by observation and model projections. */
export const COMPANION_WEATHER_LABELS = { clear: '晴朗', cloudy: '多云', rain: '下雨', snow: '下雪' } as const;
export type CompanionWeather = keyof typeof COMPANION_WEATHER_LABELS;
export function companionWeatherSymbol(weather: CompanionWeather | undefined, daylight = true): string {
  return weather === 'clear' ? daylight ? '☀' : '☾' : weather === 'cloudy' ? '☁' : weather === 'rain' ? '☂' : weather === 'snow' ? '❄' : '—';
}

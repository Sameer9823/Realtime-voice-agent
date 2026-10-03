import { z } from "zod";
import type { ServerTool } from "./types";

/**
 * Weather via Open-Meteo.
 *
 * Open-Meteo needs no API key and no account, which keeps this tool working in a fresh
 * clone with nothing configured. Geocoding and forecast come from the same provider, so a
 * city name resolves in one place.
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface WeatherDeps {
  fetchImpl?: typeof fetch;
}

/** WMO weather interpretation codes, limited to the ones worth saying out loud. */
const WMO: Record<number, string> = {
  0: "clear",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "icy fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  80: "rain showers",
  81: "rain showers",
  82: "heavy showers",
  95: "thunderstorms",
  96: "thunderstorms with hail",
  99: "severe thunderstorms",
};

/** Speaks temperatures in the unit actually returned rather than converting and rounding. */
function temperature(value: number | undefined, unit: string): string | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  const rounded = Math.round(value);
  return unit === "fahrenheit" ? `${rounded} degrees Fahrenheit` : `${rounded} degrees Celsius`;
}

export interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
}

export async function geocode(place: string, fetchImpl: typeof fetch): Promise<GeocodeResult | null> {
  const response = await fetchImpl(`${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { results?: Array<{ name: string; latitude: number; longitude: number }> };
  const first = payload.results?.[0];
  return first ? { name: first.name, latitude: first.latitude, longitude: first.longitude } : null;
}

export interface Forecast {
  description: string;
  temperature: string | null;
  high: string | null;
  low: string | null;
}

/** Formats a forecast into a single sentence the model can read straight through. */
export interface ForecastPayload {
  current?: { temperature_2m?: number; weather_code?: number };
  daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
}

/** Formats a forecast into a single sentence the model can read straight through. */
export function formatForecast(label: string, current: ForecastPayload["current"], daily: ForecastPayload["daily"], unit: string): string {
  const description = WMO[current?.weather_code ?? -1] ?? "unsettled";
  const now = temperature(current?.temperature_2m, unit);
  const high = temperature(daily?.temperature_2m_max?.[0], unit);
  const low = temperature(daily?.temperature_2m_min?.[0], unit);

  const range = high && low ? `, high ${high} and low ${low}` : "";
  return `In ${label} it's ${description} right now${now ? `, ${now}` : ""}${range}.`;
}

export function createWeatherTool(deps: WeatherDeps = {}) {
  return {
    name: "get_weather",
    description:
      "Get the current weather and today's high and low for a city. Use this whenever the user asks about weather, temperature, or a forecast. Give the place as a city name.",
    parameters: z.object({
      location: z.string().min(1).max(100).describe('City name, e.g. "Lisbon" or "Tokyo".'),
    }),
    sideEffects: false,
    async execute({ location }) {
      const doFetch = deps.fetchImpl ?? fetch;

      try {
        const place = await geocode(location, doFetch);
        if (!place) return `I couldn't find a place called ${location}.`;

        const response = await doFetch(
          `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
            `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min` +
            `&timezone=auto&temperature_unit=fahrenheit`,
          { signal: AbortSignal.timeout(6000) },
        );
        if (!response.ok) return "The weather service is unavailable right now.";

        const payload = (await response.json()) as ForecastPayload;

        return formatForecast(place.name, payload.current, payload.daily, "fahrenheit");
      } catch {
        return "The weather service didn't respond. Please try again.";
      }
    },
  } satisfies ServerTool<z.ZodObject<{ location: z.ZodString }>>;
}

export const weatherTool = createWeatherTool();
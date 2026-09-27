import { en, type MessageKey } from "@/i18n/en";

export type { MessageKey };

const dictionaries = { en } as const;
export type Locale = keyof typeof dictionaries;

/** Translate a key with {var} interpolation. Falls back to the key itself if missing. */
export function t(
  key: MessageKey,
  vars: Record<string, string | number> = {},
  locale: Locale = "en",
): string {
  const template: string = dictionaries[locale][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * i18n completeness guard for the wallet resource file. i18next falls back to
 * `en` silently, so a key missing from one dict ships English without any
 * visible error — and duplicate keys collapse inside an object literal. The
 * source is therefore parsed as text rather than imported (importing would run
 * i18next + MMKV init inside a node test).
 */
const SRC = path.join(__dirname, '..', 'i18n.ts');
const SOURCE = fs.readFileSync(SRC, 'utf8');
const LANGS = ['en', 'zh', 'de', 'fr', 'es', 'ja', 'hi', 'ar', 'pt', 'id', 'ru', 'ko'] as const;

// values are single-quoted, double-quoted when they contain an apostrophe
const PAIR = /(\w+): (?:(?:'((?:[^'\\]|\\.)*)')|(?:"((?:[^"\\]|\\.)*)"))/g;

function dict(lang: string): Map<string, string> {
  const start = SOURCE.indexOf(`\n  ${lang}: {\n    translation: {`);
  expect(start, `dict ${lang} not found`).toBeGreaterThanOrEqual(0);
  const next = LANGS[LANGS.indexOf(lang as (typeof LANGS)[number]) + 1];
  const end = next ? SOURCE.indexOf(`\n  ${next}: {\n    translation: {`) : SOURCE.indexOf('\n};\n\nexport const supportedLanguages');
  expect(end, `dict ${lang} not terminated`).toBeGreaterThan(start);
  const body = SOURCE.slice(start, end);
  const out = new Map<string, string>();
  for (const line of body.split('\n')) {
    const section = line.match(/^      (\w+): \{ (.*) \},$/);
    if (!section) continue;
    PAIR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAIR.exec(section[2]))) {
      const key = `${section[1]}.${m[1]}`;
      expect(out.has(key), `${lang} duplicate key ${key}`).toBe(false);
      out.set(key, m[2] ?? m[3]);
    }
  }
  return out;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{\{[A-Za-z0-9_]+\}\}/g)].map((m) => m[0]).sort().join(',');

const en = dict('en');

describe('wallet i18n dicts', () => {
  it('parses a non-trivial en table', () => {
    expect(en.size).toBeGreaterThan(300);
  });

  it('carry the same keys as en', () => {
    for (const lang of LANGS.slice(1)) {
      expect([...dict(lang).keys()].sort(), `${lang} key parity`).toEqual([...en.keys()].sort());
    }
  });

  it('keep every {{placeholder}} of the English value', () => {
    for (const lang of LANGS.slice(1)) {
      const d = dict(lang);
      const broken = [...en].filter(([k, v]) => d.has(k) && placeholders(d.get(k)!) !== placeholders(v));
      expect(broken.map(([k]) => k), `${lang} placeholder parity`).toEqual([]);
    }
  });

  it('ship a supportedLanguages entry for every dict', () => {
    const block = SOURCE.match(/export const supportedLanguages = \[[\s\S]*?\];/)![0];
    const codes = [...block.matchAll(/code: '(\w+)'/g)].map((m) => m[1]);
    expect(codes).toEqual([...LANGS]);
  });
});

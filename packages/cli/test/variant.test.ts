/**
 * The port is checked differentially. `fixtures/derivation.golden.json` was
 * captured by running the pre-extraction implementation over an input matrix;
 * these tests assert the new code reproduces it exactly. A behaviour change
 * that nobody intended shows up here as a diff, not on someone's phone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JetbridgeError } from '../src/project.js';
import {
  ascEntityName,
  assertSingleSegment,
  bundleIdFor,
  displayNameFor,
  exceedsLabelBudget,
  sanitizeName,
  sanitizeSuffix,
  variantTitle,
  variantWords,
} from '../src/variant.js';
import { testConfig } from './helpers/config.js';

interface Attempted<T> {
  input: string;
  [key: string]: T | string | { error: string };
}

interface Golden {
  noiseWords: string[];
  baseBundleId: string;
  defaultDisplayName: string;
  homeScreenLabelBudget: number;
  suffixes: Array<{
    input: string;
    sanitizeSuffix: string | { error: string };
    variantTitle: string | { error: string };
    bundleId: string | { error: string };
    displayName: string | { error: string };
  }>;
  displayNameOverrides: Array<{ rawSuffix: string; explicit: string; out: string }>;
  names: Array<Attempted<string>>;
  ascEntityNames: Array<Attempted<string>>;
  bundleIds: Array<{ suffix: string; out: string }>;
}

const golden: Golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/derivation.golden.json', import.meta.url)),
    'utf8',
  ),
);

const config = testConfig({
  project: { baseBundleId: golden.baseBundleId },
  variant: {
    displayName: golden.defaultDisplayName,
    labelBudget: golden.homeScreenLabelBudget,
    noiseWords: golden.noiseWords,
  },
});

/** The fixture records a thrown error as `{ error }`; run the same shape here. */
const attempt = <T>(fn: () => T): T | { error: string } => {
  try {
    return fn();
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const isError = (value: unknown): value is { error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;

describe('golden fixture: suffix derivation', () => {
  for (const row of golden.suffixes) {
    it(`derives ${JSON.stringify(row.input)}`, () => {
      const suffix = attempt(() => sanitizeSuffix(row.input, config));
      const title = attempt(() => variantTitle(row.input, config));
      const label = attempt(() => displayNameFor(row.input, '', config));

      if (isError(row.sanitizeSuffix)) expect(isError(suffix)).toBe(true);
      else expect(suffix).toBe(row.sanitizeSuffix);

      if (isError(row.variantTitle)) expect(isError(title)).toBe(true);
      else expect(title).toBe(row.variantTitle);

      if (isError(row.displayName)) expect(isError(label)).toBe(true);
      else expect(label).toBe(row.displayName);

      if (!isError(suffix) && !isError(row.bundleId)) {
        expect(bundleIdFor(suffix, config)).toBe(row.bundleId);
      }
    });
  }
});

describe('golden fixture: display names', () => {
  for (const row of golden.displayNameOverrides) {
    it(`suffix ${JSON.stringify(row.rawSuffix)} + explicit ${JSON.stringify(row.explicit)}`, () => {
      expect(displayNameFor(row.rawSuffix, row.explicit, config)).toBe(row.out);
    });
  }
});

describe('golden fixture: sanitizeName', () => {
  for (const row of golden.names) {
    it(`sanitizes ${JSON.stringify(row.input)}`, () => {
      const out = attempt(() => sanitizeName(row.input));
      if (isError(row.out)) expect(isError(out)).toBe(true);
      else expect(out).toBe(row.out);
    });
  }
});

describe('golden fixture: ascEntityName', () => {
  for (const row of golden.ascEntityNames) {
    it(`converts ${JSON.stringify(row.input)}`, () => {
      const out = attempt(() => ascEntityName(row.input));
      if (isError(row.out)) expect(isError(out)).toBe(true);
      else expect(out).toBe(row.out);
    });
  }
});

describe('golden fixture: bundleIdFor', () => {
  for (const row of golden.bundleIds) {
    it(`suffix ${JSON.stringify(row.suffix)}`, () => {
      expect(bundleIdFor(row.suffix, config)).toBe(row.out);
    });
  }
});

describe('variantWords', () => {
  const noise = new Set(['feat', 'fix', 'io', 'acme', 'app', 'dev']);

  it('drops leading noise words repeatedly', () => {
    expect(variantWords('feat/io-acme-wave', noise)).toEqual(['wave']);
  });

  it('keeps a noise word that is the entire slug', () => {
    expect(variantWords('fix', noise)).toEqual(['fix']);
    expect(variantWords('dev', noise)).toEqual(['dev']);
  });

  it('keeps a trailing noise word', () => {
    expect(variantWords('wave-dev', noise)).toEqual(['wave', 'dev']);
  });

  it('splits on every non-alphanumeric run', () => {
    expect(variantWords('a--b__c.d/e', noise)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('rejects a slug with no letters or digits', () => {
    expect(() => variantWords('---', noise)).toThrow(JetbridgeError);
  });
});

describe('noise words come from the configured bundle id', () => {
  it('derives them when the config does not list them', () => {
    const derived = testConfig({
      project: { baseBundleId: 'com.example.app.dev' },
      variant: { displayName: 'Example Dev' },
    });
    expect(sanitizeSuffix('com.example.dev.wave', derived)).toBe('wave');
    // "acme" is not part of THIS bundle id, so it is not noise here.
    expect(sanitizeSuffix('acme-wave', derived)).toBe('acmewave');
  });

  it('honours an explicit list instead', () => {
    const explicit = testConfig({ variant: { noiseWords: ['spike'] } });
    expect(sanitizeSuffix('spike/wave', explicit)).toBe('wave');
    expect(sanitizeSuffix('feat/wave', explicit)).toBe('featwave');
  });
});

describe('label prefix', () => {
  it('defaults to the first word of the display name', () => {
    expect(displayNameFor('wave', '', testConfig({ variant: { displayName: 'Acme Dev' } }))).toBe(
      'Acme Wave',
    );
  });

  it('can be set independently of the plain build label', () => {
    const config = testConfig({ variant: { displayName: 'Acme Dev', labelPrefix: 'AC' } });
    expect(displayNameFor('wave', '', config)).toBe('AC Wave');
    expect(displayNameFor('', '', config)).toBe('Acme Dev');
  });
});

describe('label budget', () => {
  it('flags a label iOS would truncate', () => {
    expect(exceedsLabelBudget('Acme Fourteen1', config)).toBe(false);
    expect(exceedsLabelBudget('Acme Fifteen123', config)).toBe(true);
  });
});

describe('assertSingleSegment', () => {
  it('rejects a pasted bundle id', () => {
    expect(() => assertSingleSegment('io.acme.dev.foo', config)).toThrow(/just the last segment/);
  });

  it('passes a plain slug through', () => {
    expect(assertSingleSegment('wave', config)).toBe('wave');
  });
});

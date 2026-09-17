/**
 * Verifies the legacy REDIS_BASE_KEY fallback reproduces the behaviour of the
 * removed bull.utils.ts + inline substring checks, so unmigrated environments
 * are unaffected by the config split.
 */
import {
  appEnv,
  bullPrefix,
  keyPrefix,
  queuesEnabled,
  webhookServerLabel,
  ConfigLike,
} from './app-config';

const cfg = (vars: Record<string, string | undefined>): ConfigLike => ({
  get: <T>(key: string, def?: T) => (vars[key] ?? def) as T | undefined,
});

// Legacy implementations, copied verbatim from the pre-refactor source.
const legacyIsLocalMode = (baseKey: string) =>
  baseKey.toUpperCase().includes('LOCAL');
const legacyBullPrefix = (baseKey: string) =>
  baseKey.endsWith(':') ? baseKey.slice(0, -1) : baseKey;
const legacyIsProd = (baseKey: string) => baseKey.includes('PROD');
const legacyServer = (baseKey: string) => {
  let server = 'dev';
  if (baseKey.includes('LOCAL')) server = baseKey;
  else if (baseKey.includes('STAGING')) server = 'staging';
  else if (baseKey.includes('PROD')) server = 'prod';
  return server;
};

const BASE_KEYS = [
  'MEDVIRTUAL:LOCAL:MANNY',
  'MEDVIRTUAL:LOCAL:',
  'MEDVIRTUAL:STAGING',
  'MEDVIRTUAL:PROD',
  'MEDVIRTUAL:PROD:MANNY',
  'medvirtual:',
  'test:',
  'something-else',
];

describe('legacy REDIS_BASE_KEY fallback parity', () => {
  for (const baseKey of BASE_KEYS) {
    describe(`REDIS_BASE_KEY="${baseKey}"`, () => {
      const c = cfg({ REDIS_BASE_KEY: baseKey });

      it('queues enabled matches !isLocalMode', () => {
        expect(queuesEnabled(c)).toBe(!legacyIsLocalMode(baseKey));
      });

      it('production detection matches includes("PROD")', () => {
        expect(appEnv(c) === 'production').toBe(
          legacyIsProd(baseKey) &&
            !legacyIsLocalMode(baseKey) &&
            !baseKey.includes('STAGING'),
        );
      });

      it('bull prefix matches the old trailing-colon strip', () => {
        expect(bullPrefix(c)).toBe(legacyBullPrefix(baseKey));
      });

      it('webhook server label is unchanged', () => {
        expect(webhookServerLabel(c)).toBe(legacyServer(baseKey));
      });
    });
  }

  it('defaults to the old medvirtual prefix when nothing is set', () => {
    expect(bullPrefix(cfg({}))).toBe('medvirtual');
    expect(keyPrefix(cfg({}))).toBe('medvirtual:');
  });

  it('normalises key prefixes to exactly one trailing colon', () => {
    expect(keyPrefix(cfg({ REDIS_KEY_PREFIX: 'A:B' }))).toBe('A:B:');
    expect(keyPrefix(cfg({ REDIS_KEY_PREFIX: 'A:B:' }))).toBe('A:B:');
    expect(keyPrefix(cfg({ REDIS_KEY_PREFIX: 'A:B::' }))).toBe('A:B:');
  });
});

describe('explicit config wins over legacy', () => {
  it('QUEUES_ENABLED overrides a LOCAL base key', () => {
    expect(
      queuesEnabled(cfg({ REDIS_BASE_KEY: 'X:LOCAL', QUEUES_ENABLED: 'true' })),
    ).toBe(true);
    expect(
      queuesEnabled(cfg({ REDIS_BASE_KEY: 'X:PROD', QUEUES_ENABLED: 'false' })),
    ).toBe(false);
  });

  it('APP_ENV overrides a PROD base key, so no accidental live Stripe keys', () => {
    const c = cfg({
      REDIS_BASE_KEY: 'MEDVIRTUAL:PROD:MANNY',
      APP_ENV: 'local',
    });
    expect(appEnv(c)).toBe('local');
    expect(webhookServerLabel(c)).toContain('local:');
  });

  it('rejects a typo rather than defaulting to on', () => {
    expect(() => queuesEnabled(cfg({ QUEUES_ENABLED: 'ture' }))).toThrow(
      /Invalid QUEUES_ENABLED/,
    );
    expect(() => appEnv(cfg({ APP_ENV: 'prodd' }))).toThrow(/Invalid APP_ENV/);
  });

  it('gives concurrent local devs distinct webhook labels', () => {
    const a = webhookServerLabel(
      cfg({ APP_ENV: 'local', INSTANCE_ID: 'manny' }),
    );
    const b = webhookServerLabel(cfg({ APP_ENV: 'local', INSTANCE_ID: 'ada' }));
    expect(a).not.toBe(b);
  });
});

// T01 — Config Loader & Entry Point tests
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './agent-config.js';

const TMP_DIR = join(import.meta.dirname, '../../.tmp-test-config');

function writeJson(name: string, obj: unknown): string {
  const p = join(TMP_DIR, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('loadConfig', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('loads a valid BDI config', () => {
    // Set env vars for interpolation
    process.env['TEST_HOST'] = 'http://localhost:8080';
    process.env['TEST_TOKEN'] = 'abc123';

    const path = writeJson('valid.json', {
      host: '${TEST_HOST}',
      token: '${TEST_TOKEN}',
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'info',
    });

    const config = loadConfig(path);
    assert.equal(config.host, 'http://localhost:8080');
    assert.equal(config.token, 'abc123');
    assert.equal(config.role, 'bdi');
    assert.equal(config.planner, 'bfs');
    assert.equal(config.logLevel, 'info');

    delete process.env['TEST_HOST'];
    delete process.env['TEST_TOKEN'];
  });

  it('throws on missing required field (host)', () => {
    const path = writeJson('missing-host.json', {
      token: 'tok',
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'info',
    });

    assert.throws(() => loadConfig(path), /Missing or invalid "host"/);
  });

  it('throws on missing required field (token)', () => {
    const path = writeJson('missing-token.json', {
      host: 'http://localhost:8080',
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'info',
    });

    assert.throws(() => loadConfig(path), /Missing or invalid "token"/);
  });

  it('throws on invalid role', () => {
    const path = writeJson('bad-role.json', {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'invalid',
      planner: 'bfs',
      logLevel: 'info',
    });

    assert.throws(() => loadConfig(path), /Missing or invalid "role"/);
  });

  it('throws on invalid planner', () => {
    const path = writeJson('bad-planner.json', {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'bdi',
      planner: 'invalid',
      logLevel: 'info',
    });

    assert.throws(() => loadConfig(path), /Missing or invalid "planner"/);
  });

  it('throws on invalid logLevel', () => {
    const path = writeJson('bad-loglevel.json', {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'verbose',
    });

    assert.throws(() => loadConfig(path), /Missing or invalid "logLevel"/);
  });

  it('throws on missing env var referenced in config', () => {
    delete process.env['NONEXISTENT_VAR_XYZ'];
    const path = writeJson('env-missing.json', {
      host: '${NONEXISTENT_VAR_XYZ}',
      token: 'tok',
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'info',
    });

    assert.throws(() => loadConfig(path), /Environment variable "NONEXISTENT_VAR_XYZ"/);
  });

  it('throws on non-existent config file', () => {
    assert.throws(() => loadConfig('/no/such/file.json'), /Cannot read config file/);
  });

  it('throws on invalid JSON', () => {
    const p = join(TMP_DIR, 'bad.json');
    writeFileSync(p, '{ not json');
    assert.throws(() => loadConfig(p), /Invalid JSON/);
  });

  it('validates llm config when role is llm', () => {
    const path = writeJson('llm-no-section.json', {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'llm',
      planner: 'llm',
      logLevel: 'info',
    });

    assert.throws(() => loadConfig(path), /"llm" config section is required/);
  });

  it('accepts a valid llm config', () => {
    const path = writeJson('llm-valid.json', {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'llm',
      planner: 'llm',
      logLevel: 'info',
      llm: {
        apiUrl: 'https://api.example.com',
        apiToken: 'key',
        model: 'test-model',
        maxTokenBudget: 4000,
        minCallIntervalMs: 1000,
      },
    });

    const config = loadConfig(path);
    assert.equal(config.llm?.apiUrl, 'https://api.example.com');
    assert.equal(config.llm?.maxTokenBudget, 4000);
  });

  it('validates metrics config when present', () => {
    const path = writeJson('bad-metrics.json', {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'info',
      metrics: {
        enabled: 'yes', // should be boolean
        sampleIntervalMs: 5000,
        outputPath: './logs/out.json',
      },
    });

    assert.throws(() => loadConfig(path), /metrics.enabled must be a boolean/);
  });

  it('interpolates env vars in nested objects', () => {
    process.env['TEST_LLM_KEY'] = 'secret-key';
    const path = writeJson('nested-env.json', {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'llm',
      planner: 'llm',
      logLevel: 'info',
      llm: {
        apiUrl: 'https://api.example.com',
        apiToken: '${TEST_LLM_KEY}',
        model: 'test',
        maxTokenBudget: 4000,
        minCallIntervalMs: 1000,
      },
    });

    const config = loadConfig(path);
    assert.equal(config.llm?.apiToken, 'secret-key');

    delete process.env['TEST_LLM_KEY'];
  });
});

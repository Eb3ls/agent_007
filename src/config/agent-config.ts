import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

import type { AgentConfig } from '../types.js';

export type { AgentConfig, AgentRole, PlannerChoice, LogLevel, LlmConfig, MetricsConfig, RecordingConfig } from '../types.js';

// --- Env var interpolation ---

/**
 * Replaces `${VAR_NAME}` placeholders in a string with values from process.env.
 * Throws if a referenced variable is not set.
 */
function interpolateEnvVars(value: string, filePath: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(
        `Environment variable "${varName}" referenced in config "${filePath}" is not set. ` +
        `Add it to your .env file or set it in your environment.`
      );
    }
    return envValue;
  });
}

/**
 * Recursively walks a parsed JSON value and interpolates ${...} in all strings.
 */
function interpolateDeep(value: unknown, filePath: string): unknown {
  if (typeof value === 'string') {
    return interpolateEnvVars(value, filePath);
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolateDeep(item, filePath));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateDeep(v, filePath);
    }
    return result;
  }
  return value;
}

// --- Validation ---

const VALID_ROLES: readonly string[] = ['bdi', 'llm', 'hybrid'];
const VALID_PLANNERS: readonly string[] = ['bfs', 'pddl', 'llm'];
const VALID_LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

function validateConfig(raw: Record<string, unknown>, filePath: string): AgentConfig {
  const errors: string[] = [];

  if (typeof raw['host'] !== 'string' || raw['host'].length === 0) {
    errors.push('Missing or invalid "host" (must be a non-empty string, e.g. "http://localhost:8080")');
  }
  if (typeof raw['token'] !== 'string' || raw['token'].length === 0) {
    errors.push('Missing or invalid "token" (must be a non-empty string)');
  }
  if (typeof raw['role'] !== 'string' || !VALID_ROLES.includes(raw['role'])) {
    errors.push(`Missing or invalid "role" (must be one of: ${VALID_ROLES.join(', ')})`);
  }
  if (typeof raw['planner'] !== 'string' || !VALID_PLANNERS.includes(raw['planner'])) {
    errors.push(`Missing or invalid "planner" (must be one of: ${VALID_PLANNERS.join(', ')})`);
  }
  if (typeof raw['logLevel'] !== 'string' || !VALID_LOG_LEVELS.includes(raw['logLevel'])) {
    errors.push(`Missing or invalid "logLevel" (must be one of: ${VALID_LOG_LEVELS.join(', ')})`);
  }

  // LLM config validation (required when role is 'llm')
  if (raw['role'] === 'llm' && raw['llm'] == null) {
    errors.push('"llm" config section is required when role is "llm"');
  }
  if (raw['llm'] != null) {
    const llm = raw['llm'] as Record<string, unknown>;
    if (typeof llm['apiUrl'] !== 'string' || llm['apiUrl'].length === 0) {
      errors.push('llm.apiUrl must be a non-empty string');
    }
    if (typeof llm['apiToken'] !== 'string' || llm['apiToken'].length === 0) {
      errors.push('llm.apiToken must be a non-empty string');
    }
    if (typeof llm['model'] !== 'string' || llm['model'].length === 0) {
      errors.push('llm.model must be a non-empty string');
    }
    if (typeof llm['maxTokenBudget'] !== 'number' || llm['maxTokenBudget'] <= 0) {
      errors.push('llm.maxTokenBudget must be a positive number');
    }
    if (typeof llm['minCallIntervalMs'] !== 'number' || llm['minCallIntervalMs'] < 0) {
      errors.push('llm.minCallIntervalMs must be a non-negative number');
    }
  }

  // Metrics config validation (optional)
  if (raw['metrics'] != null) {
    const m = raw['metrics'] as Record<string, unknown>;
    if (typeof m['enabled'] !== 'boolean') {
      errors.push('metrics.enabled must be a boolean');
    }
    if (typeof m['sampleIntervalMs'] !== 'number' || m['sampleIntervalMs'] <= 0) {
      errors.push('metrics.sampleIntervalMs must be a positive number');
    }
    if (typeof m['outputPath'] !== 'string' || m['outputPath'].length === 0) {
      errors.push('metrics.outputPath must be a non-empty string');
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid config "${filePath}":\n  - ${errors.join('\n  - ')}`
    );
  }

  return raw as unknown as AgentConfig;
}

// --- Public API ---

/**
 * Loads, interpolates, and validates an agent config from a JSON file.
 * Environment variables (from .env via dotenv) override ${VAR} placeholders.
 */
export function loadConfig(configPath: string): AgentConfig {
  // Load .env into process.env (idempotent — won't overwrite existing vars)
  loadDotenv();

  const absolutePath = resolve(configPath);

  let rawText: string;
  try {
    rawText = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config file "${absolutePath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Invalid JSON in config file "${absolutePath}": ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file "${absolutePath}" must contain a JSON object`);
  }

  const interpolated = interpolateDeep(parsed, absolutePath) as Record<string, unknown>;
  return validateConfig(interpolated, absolutePath);
}

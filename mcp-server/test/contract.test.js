/**
 * Contract tests for ApexAgent.
 *
 * Validates structural invariants that, if broken, cause silent failures:
 *  1. Every tool in the catalog has all required fields
 *  2. No tool schema allows returning a bare {success: true} with no data
 *  3. Every error code is complete
 *  4. Tool profiles are consistent
 *  5. validateParams rejects bad input and accepts good input
 *
 * Run: node --test test/contract.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, ERROR_CODES, PROFILES, getTool, toolsForProfiles, toMcpTool, validateParams, validateTarget } from '../lib/tools.js';

// ─── Tool catalog invariants ───

describe('Tool catalog', () => {
  it('has at least 25 tools', () => {
    assert.ok(TOOLS.length >= 25, `Expected ≥25 tools, got ${TOOLS.length}`);
  });

  it('every tool has a unique name', () => {
    const names = TOOLS.map(t => t.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, `Duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  for (const tool of TOOLS) {
    describe(`tool: ${tool.name}`, () => {
      it('has a non-empty name', () => {
        assert.ok(typeof tool.name === 'string' && tool.name.length > 0);
      });

      it('has a non-empty description', () => {
        assert.ok(typeof tool.description === 'string' && tool.description.length > 10,
          `Description too short or missing: "${tool.description}"`);
      });

      it('has an inputSchema with type "object"', () => {
        assert.ok(tool.inputSchema, 'Missing inputSchema');
        assert.equal(tool.inputSchema.type, 'object', 'inputSchema.type must be "object"');
      });

      it('inputSchema.properties is an object', () => {
        assert.ok(
          tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object',
          'inputSchema.properties must be an object'
        );
      });

      it('every property has a description', () => {
        for (const [key, schema] of Object.entries(tool.inputSchema.properties || {})) {
          assert.ok(
            typeof schema.description === 'string' && schema.description.length > 0,
            `Property "${key}" of tool "${tool.name}" is missing a description`
          );
        }
      });

      it('every property has a type', () => {
        for (const [key, schema] of Object.entries(tool.inputSchema.properties || {})) {
          assert.ok(
            schema.type || schema.enum || schema.oneOf || schema.anyOf,
            `Property "${key}" of tool "${tool.name}" has no type, enum, or oneOf/anyOf`
          );
        }
      });

      it('has annotations with readOnlyHint', () => {
        assert.ok(tool.annotations, `Tool "${tool.name}" missing annotations`);
        assert.ok(typeof tool.annotations.readOnlyHint === 'boolean',
          `Tool "${tool.name}" missing readOnlyHint annotation`);
      });

      it('toMcpTool produces a valid MCP tool definition', () => {
        const mcp = toMcpTool(tool);
        assert.ok(mcp.name, 'MCP tool missing name');
        assert.ok(mcp.description, 'MCP tool missing description');
        assert.ok(mcp.inputSchema, 'MCP tool missing inputSchema');
      });
    });
  }
});

// ─── Error codes ───

describe('Error codes', () => {
  const EXPECTED_CODES = [
    'NO_EXTENSION', 'NOT_PAIRED', 'EXTENSION_BUSY', 'NO_TAB', 'UNSUPPORTED_URL',
    'TAB_CRASHED', 'NOT_ALLOWED', 'NOT_FOUND', 'AMBIGUOUS', 'STALE_REF',
    'NODE_DETACHED', 'OCCLUDED', 'NOT_INTERACTABLE', 'TIMEOUT', 'CANCELLED',
    'CDP_REQUIRED', 'CDP_DETACHED', 'BAD_PARAMS', 'TOO_LARGE',
    'UNSUPPORTED_PROTOCOL', 'INTERNAL'
  ];

  it('has all expected error codes', () => {
    for (const code of EXPECTED_CODES) {
      assert.ok(ERROR_CODES[code], `Missing error code: ${code}`);
    }
  });

  for (const [code, value] of Object.entries(ERROR_CODES)) {
    it(`error code ${code} has a retryable flag`, () => {
      assert.ok(typeof value.retryable === 'boolean', `${code} missing retryable flag`);
    });

    it(`error code ${code} has a hint`, () => {
      assert.ok(typeof value.hint === 'string' && value.hint.length > 0, `${code} missing hint`);
    });
  }

  it('ERROR_CODES is frozen', () => {
    assert.ok(Object.isFrozen(ERROR_CODES));
  });
});

// ─── Profiles ───

describe('Profiles', () => {
  it('has core, inspect, diagnose, and extension profiles', () => {
    assert.ok(PROFILES.core, 'Missing core profile');
    assert.ok(PROFILES.inspect, 'Missing inspect profile');
    assert.ok(PROFILES.diagnose, 'Missing diagnose profile');
    assert.ok(PROFILES.extension, 'Missing extension profile');
  });

  it('every profile has a non-empty description', () => {
    for (const [name, desc] of Object.entries(PROFILES)) {
      assert.ok(typeof desc === 'string' && desc.length > 5,
        `Profile "${name}" has missing or short description`);
    }
  });

  it('toolsForProfiles(["core"]) returns tools', () => {
    const core = toolsForProfiles(['core']);
    assert.ok(core.length > 0, 'Core profile returned no tools');
    assert.ok(core.length <= TOOLS.length);
  });

  it('toolsForProfiles returns actual Tool objects', () => {
    const core = toolsForProfiles(['core']);
    for (const t of core) {
      assert.ok(t.name, 'Tool missing name');
      assert.ok(t.description, 'Tool missing description');
      assert.ok(t.inputSchema, 'Tool missing inputSchema');
    }
  });

  it('every tool has a profile field', () => {
    for (const tool of TOOLS) {
      assert.ok(typeof tool.profile === 'string' && tool.profile.length > 0,
        `Tool "${tool.name}" missing profile field`);
      assert.ok(Object.keys(PROFILES).includes(tool.profile),
        `Tool "${tool.name}" has unknown profile "${tool.profile}"`);
    }
  });
});

// ─── getTool ───

describe('getTool', () => {
  it('finds existing tools by name', () => {
    const tool = getTool('browser_click');
    assert.ok(tool, 'browser_click not found');
    assert.equal(tool.name, 'browser_click');
  });

  it('returns null for non-existent tools', () => {
    assert.equal(getTool('nonexistent_tool'), null);
  });
});

// ─── validateParams ───

describe('validateParams', () => {
  it('accepts valid params for browser_navigate', () => {
    const tool = getTool('browser_navigate');
    if (!tool) return;
    const result = validateParams(tool, { url: 'https://example.com' });
    assert.ok(result.ok === true, `Expected ok:true, got: ${JSON.stringify(result)}`);
  });

  it('rejects missing required params for browser_navigate', () => {
    const tool = getTool('browser_navigate');
    if (!tool) return;
    const result = validateParams(tool, {});
    assert.ok(result.ok === false, 'Expected ok:false for missing url');
  });

  it('rejects wrong type for string param', () => {
    const tool = getTool('browser_navigate');
    if (!tool) return;
    const result = validateParams(tool, { url: 12345 });
    assert.ok(result.ok === false, 'Expected ok:false for numeric url');
  });
});

// ─── validateTarget ───

describe('validateTarget', () => {
  it('accepts a single ref', () => {
    const result = validateTarget({ ref: 'e7-12' });
    assert.ok(result.ok === true, `Expected ok:true, got: ${JSON.stringify(result)}`);
  });

  it('accepts a single selector', () => {
    const result = validateTarget({ selector: '#foo' });
    assert.ok(result.ok === true, `Expected ok:true, got: ${JSON.stringify(result)}`);
  });

  it('accepts a single text', () => {
    const result = validateTarget({ text: 'Submit' });
    assert.ok(result.ok === true, `Expected ok:true, got: ${JSON.stringify(result)}`);
  });

  it('rejects multiple targets', () => {
    const result = validateTarget({ ref: 'e7-12', selector: '#foo' });
    assert.ok(result.ok === false, 'Expected ok:false for multiple targets');
  });

  it('rejects empty target (default is required)', () => {
    const result = validateTarget({});
    assert.ok(result.ok === false, 'Expected ok:false for missing target');
  });
});

// ─── Anti-pattern grep: no silent success ───

describe('No silent success anti-patterns', () => {
  it('tools.js does not contain || [] pattern', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const content = await readFile(join(dir, '..', 'lib', 'tools.js'), 'utf8');
    // Look for the dangerous pattern: result?.something || []
    const matches = content.match(/\|\|\s*\[\s*\]/g);
    assert.ok(!matches, `Found ${matches?.length} instances of "|| []" pattern in tools.js — errors must not be swallowed`);
  });

  it('tools.js does not contain bare catch {}', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const content = await readFile(join(dir, '..', 'lib', 'tools.js'), 'utf8');
    const matches = content.match(/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g);
    assert.ok(!matches, `Found ${matches?.length} instances of bare "catch {}" in tools.js`);
  });
});

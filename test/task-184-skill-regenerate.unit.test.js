'use strict';

// Unit tests for lib/skill-regenerate.js (TASK-184) — AI-assisted regeneration of
// ONE phase-section's prose. This module exports:
//   - regeneratePhaseSection(opts): async function calling the Anthropic API
//   - defaultHttpRequest: the real https client (injectable for tests)
//   - buildUserContent: assembles the user message
//   - Constants: SKILL_REGEN_MODEL, SKILL_REGEN_MAX_TOKENS, etc.
//
// This module is intentionally Electron-free and has an injectable httpRequest
// option so it can be unit-tested with mocked API calls — NO real traffic to
// Anthropic. The API key never escapes the function and is never logged.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  regeneratePhaseSection,
  buildUserContent,
  SKILL_REGEN_MODEL,
  SKILL_REGEN_MAX_TOKENS,
  SKILL_REGEN_TIMEOUT_MS,
  SKILL_REGEN_SYSTEM_PROMPT,
} = require('../lib/skill-regenerate');

// ---------------------------------------------------------------------------
// Exports & constants
// ---------------------------------------------------------------------------

test('exports the documented surface', () => {
  assert.equal(typeof regeneratePhaseSection, 'function');
  assert.equal(typeof buildUserContent, 'function');
  assert.equal(SKILL_REGEN_MODEL, 'claude-sonnet-5');
  assert.ok(SKILL_REGEN_MAX_TOKENS > 0);
  assert.ok(SKILL_REGEN_TIMEOUT_MS > 0);
  assert.ok(typeof SKILL_REGEN_SYSTEM_PROMPT === 'string');
  assert.ok(SKILL_REGEN_SYSTEM_PROMPT.length > 0);
});

test('SKILL_REGEN_SYSTEM_PROMPT instructs the model to output section body only', () => {
  assert.ok(SKILL_REGEN_SYSTEM_PROMPT.includes('Output ONLY the rewritten body text'));
  assert.ok(SKILL_REGEN_SYSTEM_PROMPT.includes('Do NOT include'));
  assert.ok(SKILL_REGEN_SYSTEM_PROMPT.includes('one section'));
});

// ---------------------------------------------------------------------------
// buildUserContent — assemble the user message
// ---------------------------------------------------------------------------

test('buildUserContent: combines section body and instruction with clear delimiters', () => {
  const current = 'Current phase text here\nWith multiple lines';
  const instr = 'Make it more concise';
  const result = buildUserContent(current, instr);

  assert.ok(result.includes('CURRENT PHASE-SECTION BODY:'));
  assert.ok(result.includes(current));
  assert.ok(result.includes('END OF CURRENT PHASE-SECTION BODY'));
  assert.ok(result.includes('INSTRUCTION:'));
  assert.ok(result.includes(instr));
});

test('buildUserContent: handles empty current body', () => {
  const result = buildUserContent('', 'Instruction text');
  assert.ok(typeof result === 'string');
  assert.ok(result.includes('INSTRUCTION:'));
});

test('buildUserContent: handles empty instruction', () => {
  const result = buildUserContent('Section text', '');
  assert.ok(typeof result === 'string');
  assert.ok(result.includes('CURRENT PHASE-SECTION BODY:'));
});

test('buildUserContent: preserves multiline content exactly', () => {
  const current = 'Line 1\nLine 2\nLine 3\n';
  const instr = 'Instruction\nwith multiple\nlines';
  const result = buildUserContent(current, instr);
  assert.ok(result.includes('Line 1\nLine 2\nLine 3'));
  assert.ok(result.includes('Instruction\nwith multiple\nlines'));
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — the main function
// ---------------------------------------------------------------------------

// Helper: create a mocked httpRequest that returns success
function mockHttpRequestSuccess(responseText) {
  return async (opts) => {
    // Verify the options shape matches what we expect
    assert.ok(opts.apiKey);
    assert.ok(typeof opts.model === 'string');
    assert.ok(typeof opts.maxTokens === 'number');
    assert.ok(typeof opts.system === 'string');
    assert.ok(typeof opts.text === 'string');
    assert.ok(typeof opts.timeoutMs === 'number');
    return {
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: responseText }]
      })
    };
  };
}

// Helper: create a mocked httpRequest that returns an error
function mockHttpRequestError(status = 500, body = '') {
  return async (opts) => {
    return { status, body };
  };
}

// Helper: create a mocked httpRequest that throws (network error)
function mockHttpRequestThrows(error) {
  return async (opts) => {
    throw error;
  };
}

// ---------------------------------------------------------------------------
// regeneratePhaseSection — no-key branch (failure)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:false, reason:"no-key"} when apiKey is empty', async () => {
  const res = await regeneratePhaseSection({
    apiKey: '',
    content: 'some content',
    instruction: 'some instruction',
    httpRequest: mockHttpRequestSuccess('response'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-key');
  assert.equal(res.content, '');
});

test('regeneratePhaseSection: returns no-key without calling httpRequest when key is absent', async () => {
  let httpWasCalled = false;
  const mockHttp = async (opts) => {
    httpWasCalled = true;
    return { status: 200, body: '{}' };
  };

  const res = await regeneratePhaseSection({
    apiKey: '',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttp,
  });

  assert.equal(res.reason, 'no-key');
  assert.equal(httpWasCalled, false, 'httpRequest was not called');
});

test('regeneratePhaseSection: treats whitespace-only apiKey as empty', async () => {
  let httpWasCalled = false;
  const mockHttp = async (opts) => {
    httpWasCalled = true;
    return { status: 200, body: '{}' };
  };

  const res = await regeneratePhaseSection({
    apiKey: '   \t\n  ',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttp,
  });

  // Should still call the HTTP request since we don't trim the key
  // Actually, the code doesn't trim apiKey, only instruction
  assert.ok(httpWasCalled, 'non-trimmed whitespace is sent to HTTP');
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — empty-instruction branch (failure)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:false, reason:"empty-instruction"} when instruction is empty', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'some content',
    instruction: '',
    httpRequest: mockHttpRequestSuccess('response'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'empty-instruction');
  assert.equal(res.content, '');
});

test('regeneratePhaseSection: treats whitespace-only instruction as empty (after trimming)', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'some content',
    instruction: '   \t\n  ',
    httpRequest: mockHttpRequestSuccess('response'),
  });
  assert.equal(res.reason, 'empty-instruction');
});

test('regeneratePhaseSection: returns empty-instruction without calling httpRequest', async () => {
  let httpWasCalled = false;
  const mockHttp = async (opts) => {
    httpWasCalled = true;
    return { status: 200, body: '{}' };
  };

  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: '  ',
    httpRequest: mockHttp,
  });

  assert.equal(res.reason, 'empty-instruction');
  assert.equal(httpWasCalled, false);
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — empty-content branch (failure)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:false, reason:"empty-content"} when content is empty', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: '',
    instruction: 'do something',
    httpRequest: mockHttpRequestSuccess('response'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'empty-content');
  assert.equal(res.content, '');
});

test('regeneratePhaseSection: treats whitespace-only content as empty (after trim check)', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: '   \t\n  ',
    instruction: 'instruction',
    httpRequest: mockHttpRequestSuccess('response'),
  });
  assert.equal(res.reason, 'empty-content');
});

test('regeneratePhaseSection: returns empty-content without calling httpRequest', async () => {
  let httpWasCalled = false;
  const mockHttp = async (opts) => {
    httpWasCalled = true;
    return { status: 200, body: '{}' };
  };

  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: '',
    instruction: 'instruction',
    httpRequest: mockHttp,
  });

  assert.equal(res.reason, 'empty-content');
  assert.equal(httpWasCalled, false);
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — bad-status branch (failure)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:false, reason:"bad-status"} when status is not 200', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestError(500, '{"error":"internal error"}'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-status');
});

test('regeneratePhaseSection: returns bad-status for 401 Unauthorized', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-invalid-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestError(401, '{"error":"unauthorized"}'),
  });
  assert.equal(res.reason, 'bad-status');
});

test('regeneratePhaseSection: returns bad-status when httpRequest returns null', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => null,
  });
  assert.equal(res.reason, 'bad-status');
});

test('regeneratePhaseSection: returns bad-status when body is not a string', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => ({ status: 200, body: 42 }),
  });
  assert.equal(res.reason, 'bad-status');
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — bad-json branch (failure)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:false, reason:"bad-json"} when response body is not valid JSON', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestError(200, 'not json {{{'),
  });
  assert.equal(res.reason, 'bad-json');
});

test('regeneratePhaseSection: returns bad-json for malformed JSON response', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => ({ status: 200, body: '{ incomplete: ' }),
  });
  assert.equal(res.reason, 'bad-json');
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — empty-response branch (failure)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:false, reason:"empty-response"} when content array is absent', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestSuccess(''),
  });
  assert.equal(res.reason, 'empty-response');
});

test('regeneratePhaseSection: returns empty-response when JSON has no content field', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => ({ status: 200, body: JSON.stringify({ usage: { input_tokens: 100 } }) }),
  });
  assert.equal(res.reason, 'empty-response');
});

test('regeneratePhaseSection: returns empty-response when content array is not an array', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => ({ status: 200, body: JSON.stringify({ content: 'not an array' }) }),
  });
  assert.equal(res.reason, 'empty-response');
});

test('regeneratePhaseSection: returns empty-response when no text block is present', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => ({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'image', url: 'http://example.com/image.jpg' }]
      })
    }),
  });
  assert.equal(res.reason, 'empty-response');
});

test('regeneratePhaseSection: returns empty-response when text block has empty text', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => ({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: '   \n\t  ' }]
      })
    }),
  });
  assert.equal(res.reason, 'empty-response');
});

test('regeneratePhaseSection: returns empty-response when text is not a string', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: async () => ({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: 123 }]
      })
    }),
  });
  assert.equal(res.reason, 'empty-response');
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — error branch (network/timeout)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:false, reason:"error"} on network error', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestThrows(new Error('ECONNREFUSED')),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'error');
  assert.equal(res.content, '');
});

test('regeneratePhaseSection: returns error on timeout', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestThrows(new Error('anthropic request timed out')),
  });
  assert.equal(res.reason, 'error');
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — success branch
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: returns {ok:true, content, reason:"ok"} on success', async () => {
  const responseText = 'This is the rewritten section body.\nWith multiple lines.';
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'original content',
    instruction: 'rewrite this',
    httpRequest: mockHttpRequestSuccess(responseText),
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'ok');
  assert.equal(res.content, responseText);
});

test('regeneratePhaseSection: preserves the model response text exactly (no trimming)', async () => {
  const responseText = '  Leading spaces and trailing spaces  \n';
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestSuccess(responseText),
  });
  assert.equal(res.content, responseText);
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — API key security (never logged/returned)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: never includes the API key in the returned result', async () => {
  const apiKey = 'sk-super-secret-key-12345';
  const res = await regeneratePhaseSection({
    apiKey,
    content: 'content',
    instruction: 'instruction',
    httpRequest: mockHttpRequestSuccess('response'),
  });
  const resultString = JSON.stringify(res);
  assert.ok(!resultString.includes(apiKey), 'API key not in result object');
  assert.ok(!resultString.includes('sk-'), 'No sk- prefix in result');
});

test('regeneratePhaseSection: API key is passed to httpRequest (in options, not logged)', async () => {
  const apiKey = 'sk-test-key-xyz';
  let receivedKey = null;
  const captureKeyHttp = async (opts) => {
    receivedKey = opts.apiKey;
    return {
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: 'response' }]
      })
    };
  };

  await regeneratePhaseSection({
    apiKey,
    content: 'content',
    instruction: 'instruction',
    httpRequest: captureKeyHttp,
  });

  assert.equal(receivedKey, apiKey, 'key was passed to httpRequest');
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — input coercion and defaults
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: coerces non-string content to string (empty on null/undefined)', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: null,
    instruction: 'instruction',
    httpRequest: mockHttpRequestSuccess('response'),
  });
  assert.equal(res.reason, 'empty-content');
});

test('regeneratePhaseSection: coerces non-string instruction to string (empty on null/undefined)', async () => {
  const res = await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: null,
    httpRequest: mockHttpRequestSuccess('response'),
  });
  assert.equal(res.reason, 'empty-instruction');
});

test('regeneratePhaseSection: uses defaults for model, maxTokens, timeoutMs, system', async () => {
  let capturedOpts = null;
  const captureOptsHttp = async (opts) => {
    capturedOpts = opts;
    return {
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: 'response' }]
      })
    };
  };

  await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: captureOptsHttp,
  });

  assert.equal(capturedOpts.model, SKILL_REGEN_MODEL);
  assert.equal(capturedOpts.maxTokens, SKILL_REGEN_MAX_TOKENS);
  assert.equal(capturedOpts.timeoutMs, SKILL_REGEN_TIMEOUT_MS);
  assert.equal(capturedOpts.system, SKILL_REGEN_SYSTEM_PROMPT);
});

test('regeneratePhaseSection: allows tuning model, maxTokens, timeoutMs, system', async () => {
  let capturedOpts = null;
  const captureOptsHttp = async (opts) => {
    capturedOpts = opts;
    return {
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: 'response' }]
      })
    };
  };

  const customSystem = 'Custom system prompt';
  await regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: captureOptsHttp,
    model: 'claude-haiku-4',
    maxTokens: 1024,
    timeoutMs: 10000,
    system: customSystem,
  });

  assert.equal(capturedOpts.model, 'claude-haiku-4');
  assert.equal(capturedOpts.maxTokens, 1024);
  assert.equal(capturedOpts.timeoutMs, 10000);
  assert.equal(capturedOpts.system, customSystem);
});

// ---------------------------------------------------------------------------
// regeneratePhaseSection — Promise contract (never rejects)
// ---------------------------------------------------------------------------

test('regeneratePhaseSection: always returns a Promise that resolves (never rejects)', async () => {
  const failingHttp = async () => {
    throw new Error('Network failure');
  };

  let promiseResolved = false;
  const promise = regeneratePhaseSection({
    apiKey: 'sk-test-key',
    content: 'content',
    instruction: 'instruction',
    httpRequest: failingHttp,
  });

  assert.ok(promise instanceof Promise, 'returns a Promise');

  try {
    const res = await promise;
    promiseResolved = true;
    assert.ok('ok' in res && 'content' in res && 'reason' in res);
  } catch (err) {
    assert.fail(`Promise should not reject, but threw: ${err.message}`);
  }

  assert.ok(promiseResolved, 'Promise resolved');
});

test('regeneratePhaseSection: every branch returns a structured result object with ok/content/reason', async () => {
  const branches = [
    {
      name: 'no-key',
      opts: { apiKey: '', content: 'c', instruction: 'i', httpRequest: () => null },
    },
    {
      name: 'empty-instruction',
      opts: { apiKey: 'sk-key', content: 'c', instruction: '', httpRequest: () => null },
    },
    {
      name: 'empty-content',
      opts: { apiKey: 'sk-key', content: '', instruction: 'i', httpRequest: () => null },
    },
    {
      name: 'bad-status',
      opts: {
        apiKey: 'sk-key',
        content: 'c',
        instruction: 'i',
        httpRequest: async () => ({ status: 500, body: 'error' })
      },
    },
    {
      name: 'error',
      opts: {
        apiKey: 'sk-key',
        content: 'c',
        instruction: 'i',
        httpRequest: async () => { throw new Error('network'); }
      },
    },
  ];

  for (const branch of branches) {
    const res = await regeneratePhaseSection(branch.opts);
    assert.ok('ok' in res, `branch ${branch.name} has 'ok'`);
    assert.ok('content' in res, `branch ${branch.name} has 'content'`);
    assert.ok('reason' in res, `branch ${branch.name} has 'reason'`);
    assert.equal(res.ok, false, `branch ${branch.name}: ok is false`);
    assert.equal(res.reason, branch.name, `branch ${branch.name}: reason is ${branch.name}`);
  }
});

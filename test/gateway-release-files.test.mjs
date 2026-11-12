import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { root, checkDockerRuntime } from '../scripts/release-files.mjs';
import path from 'node:path';

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
const required = ['src/prompt-tool-schema.mjs', 'src/image-input.mjs', 'src/image-url.mjs', 'src/openai-usage.mjs', 'src/responses-tool-namespaces.mjs'];

test('Docker runtime copies all local imports and required assets through its default-deny context', () => {
  assert.ok(checkDockerRuntime().files > required.length);
});

for (const name of required) {
  test(`Docker release check rejects an omitted COPY dependency: ${name}`, () => {
    assert.ok(dockerfile.includes(name + ' '));
    assert.throws(() => checkDockerRuntime({ dockerfile: dockerfile.replace(name + ' ', '') }), /Missing Docker import:/);
  });
  test(`Docker release check rejects an ignored dependency: ${name}`, () => {
    assert.ok(dockerignore.includes('!' + name + '\n'));
    assert.throws(() => checkDockerRuntime({ dockerignore: dockerignore.replace('!' + name + '\n', '') }), /Docker context excludes:/);
  });
}

test('Docker release check requires allowed parents and refuses a raw-workspace COPY', () => {
  assert.throws(() => checkDockerRuntime({ dockerignore: dockerignore.replace('!src/\n', '') }), /Docker context excludes parent:/);
  assert.throws(() => checkDockerRuntime({ dockerfile: dockerfile + '\nCOPY . .\n' }), /Docker COPY source outside curated release:/);
  assert.throws(() => checkDockerRuntime({ dockerignore: dockerignore.replace('**\n', '') }), /Docker context must be default-deny/);
});

test('Docker image leaves public origin to deployment and Compose follows its published port', () => {
  const imageEnvironment = dockerfile.split(/\r?\n/).filter(line => /^ENV\s/.test(line)).join('\n');
  assert.doesNotMatch(imageEnvironment, /\bGATEWAY_PUBLIC_ORIGIN=/);
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.ok(compose.includes('127.0.0.1:${GATEWAY_PUBLISHED_PORT:-18989}:18989'));
  assert.ok(compose.includes('${GATEWAY_PUBLIC_ORIGIN:-http://127.0.0.1:${GATEWAY_PUBLISHED_PORT:-18989}}'));
  assert.ok(compose.includes('127.0.0.1:18765:18765'));
});

test('Compose tmpfs options remain one quoted mount rather than separate relative paths', () => {
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.match(compose, /^\s+tmpfs:\s+\["\/tmp:rw,noexec,nosuid,size=16m"\]\s*$/m);
});

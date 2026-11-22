import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';

test('Admin UI exposes MCP endpoints, snippets, and bilingual mcpEnabled toggle that controls POST /mcp', async ({ page }) => {
  const f = await fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // 1. Sign in on Settings and verify mcpEnabled defaults ON
    await page.goto(f.base + '/admin/#settings');
    await page.locator('#admin-password').fill(PASSWORD);
    await page.locator('#login-submit').click();

    const mcpToggle = page.getByRole('switch', { name: 'Enable MCP Streamable HTTP endpoint' });
    await expect(mcpToggle).toBeChecked();
    await expect(page.locator('#mcp-enabled-help')).toContainText('POST /mcp');
    expect(f.store.settings().mcpEnabled).toBe(true);

    // 2. Accounts home page Quick Connect includes MCP preset with real /mcp URL and no leaked secret
    await page.goto(f.base + '/admin/#accounts');
    const mcpPreset = page.locator('.preset-tab[data-preset="mcp"]');
    await expect(mcpPreset).toBeVisible();
    await mcpPreset.click();
    const deckSnippet = page.locator('.deck-snippet');
    await expect(deckSnippet).toContainText(`${f.base}/mcp`);
    await expect(deckSnippet).toContainText('GEMINI_GATEWAY_KEY');
    await expect(deckSnippet).not.toContainText(f.key.key);

    // 3. Client Setup (Models) displays MCP Endpoint URL, Enabled badge, and MCP HTTP/stdio tabs
    await page.goto(f.base + '/admin/#models');
    await expect(page.locator('#client-mcp-url')).toHaveValue(`${f.base}/mcp`);
    await expect(page.locator('#client-mcp-status')).toContainText('MCP enabled');
    await page.locator('#snippet-mcp-http').click();
    await expect(page.locator('#client-snippet')).toContainText(`${f.base}/mcp`);
    await expect(page.locator('#client-snippet')).toContainText('mcpServers');
    await page.locator('#snippet-mcp-stdio').click();
    await expect(page.locator('#client-snippet')).toContainText('gemini-app2api');
    await expect(page.locator('#client-snippet')).toContainText('GEMINI_GATEWAY_URL');

    // 4. API Keys page displays both /v1 and /mcp endpoints
    await page.goto(f.base + '/admin/#keys');
    await expect(page.locator('#copy-keys-base')).toBeVisible();
    await expect(page.locator('#copy-keys-mcp')).toBeVisible();
    await expect(page.locator('#keys-mcp-status')).toContainText('Enabled');

    // 5. Disabling MCP in Settings persists, blocks POST /mcp with 403 MCP_DISABLED, and updates UI badges
    await page.goto(f.base + '/admin/#settings');
    await mcpToggle.uncheck();
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-feedback')).toBeVisible();
    expect(f.store.settings().mcpEnabled).toBe(false);

    const disabledRes = await f.api('/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(disabledRes.status).toBe(403);
    expect((await disabledRes.json()).error.code).toBe('MCP_DISABLED');
    expect((await f.api('/v1/models')).status).toBe(200);

    await page.goto(f.base + '/admin/#models');
    await expect(page.locator('#client-mcp-status')).toContainText('MCP disabled');
    await page.locator('#snippet-mcp-http').click();
    await expect(page.locator('#client-mcp-disabled-notice')).toBeVisible();

    // 6. Trilingual zh-HK and zh-CN switches update UI cleanly and re-enable MCP
    await page.goto(f.base + '/admin/#settings');
    await page.locator('#lang-zh-HK').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-HK');
    const zhToggle = page.getByRole('switch', { name: '啟用 MCP Streamable HTTP 端點' });
    await expect(zhToggle).not.toBeChecked();

    await page.locator('#lang-zh-CN').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('nav a')).toHaveText(['账户', 'API 密钥', '设置']);
    const cnToggle = page.getByRole('switch', { name: '启用 MCP Streamable HTTP 端点' });
    await expect(cnToggle).not.toBeChecked();
    await cnToggle.check();
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-feedback')).toBeVisible();
    expect(f.store.settings().mcpEnabled).toBe(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(cnToggle).toBeChecked();

    const enabledRes = await f.api('/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 2, method: 'ping' },
    });
    expect(enabledRes.status).toBe(200);
    expect(f.seen).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

import * as assert from 'node:assert';

import * as vscode from 'vscode';

suite('Safe AI Factory Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present and active', async () => {
    const extension = vscode.extensions.getExtension('JuroOravec.safe-ai-factory');
    assert.ok(extension, 'Extension not found');

    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, 'Extension failed to activate');
  });

  test('Core commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('saif.createFeature'), 'createFeature command is missing');
    assert.ok(commands.includes('saif.runFeature'), 'runFeature command is missing');
    assert.ok(commands.includes('saif.showLogs'), 'showLogs command is missing');
  });
});

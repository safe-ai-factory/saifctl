import * as assert from 'node:assert';

import * as vscode from 'vscode';

suite('SaifCTL extension test suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present and active', async () => {
    const extension = vscode.extensions.getExtension('JuroOravec.saifctl');
    assert.ok(extension, 'Extension not found');

    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, 'Extension failed to activate');
  });

  test('Core commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('saifctl.createFeature'), 'createFeature command is missing');
    assert.ok(commands.includes('saifctl.runFeature'), 'runFeature command is missing');
    assert.ok(commands.includes('saifctl.designFeature'), 'designFeature command is missing');
    assert.ok(
      commands.includes('saifctl.openFeatureProposal'),
      'openFeatureProposal command is missing',
    );
    assert.ok(commands.includes('saifctl.showLogs'), 'showLogs command is missing');
    assert.ok(commands.includes('saifctl.manageSecrets'), 'manageSecrets command is missing');
  });
});

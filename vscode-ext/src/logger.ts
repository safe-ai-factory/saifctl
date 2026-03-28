import * as vscode from 'vscode';

// The { log: true } flag is crucial. It gives us info/warn/error/trace levels
// and gives the user a nice dropdown in the UI to filter them.
export const saifLogger = vscode.window.createOutputChannel('SaifCTL', { log: true });

/**
 * 最小 vscode 模块 mock，让 out/ai/client.js 之类能在 Node 测试脚本里跑。
 * 注入方式：在 test 脚本顶部 require('./vscode-mock'); （它自动 patch 模块解析）
 */
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') {
    // 返回此文件路径，Node 会加载它作为 vscode 模块
    return __filename;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// 测试场景：扩展的 claudeCoach.* config 都为空（profileManager 走 profiles.json 路径）
function getConfiguration(section) {
  return {
    get(key, defaultValue) {
      return defaultValue !== undefined ? defaultValue : '';
    },
    has() { return false; },
    inspect() { return undefined; },
    update() { return Promise.resolve(); },
  };
}

module.exports = {
  workspace: {
    getConfiguration,
    workspaceFolders: undefined,
    onDidChangeConfiguration() { return { dispose() {} }; },
  },
  Uri: {
    file(p) { return { fsPath: p, path: p, toString() { return p; } }; },
    joinPath(base, ...segs) { return { fsPath: [base.fsPath || base, ...segs].join('/'), toString() { return [base.fsPath || base, ...segs].join('/'); } }; },
    parse(s) { return { fsPath: s, toString() { return s; } }; },
  },
  window: {
    showErrorMessage(msg) { console.error('[vscode.window.error]', msg); },
    showWarningMessage(msg) { console.warn('[vscode.window.warn]', msg); },
    showInformationMessage(msg) { console.log('[vscode.window.info]', msg); },
  },
  env: {
    openExternal: () => Promise.resolve(true),
  },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
};

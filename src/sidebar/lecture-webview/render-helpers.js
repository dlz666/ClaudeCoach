// render-helpers.js
// 通用渲染助手：source-line 插件、选区 -> 行号、HTML 转义。
// 通过全局 window.LectureRenderHelpers 暴露，给 main.js 使用。

(function (global) {
  'use strict';

  /** markdown-it 插件：给 token.map 可用的 block-level 节点都打上 data-source-line。 */
  function attachSourceLines(md) {
    var TYPES = [
      'paragraph_open', 'heading_open', 'blockquote_open',
      'bullet_list_open', 'ordered_list_open', 'list_item_open',
      'fence', 'code_block', 'table_open', 'hr', 'html_block',
    ];
    TYPES.forEach(function (type) {
      var original = md.renderer.rules[type] || function (tokens, i, options, env, self) {
        return self.renderToken(tokens, i, options);
      };
      md.renderer.rules[type] = function (tokens, idx, options, env, self) {
        var token = tokens[idx];
        if (token.map && token.level === 0) {
          token.attrSet('data-source-line', String(token.map[0]));
          token.attrSet('data-source-line-end', String(token.map[1]));
        }
        return original(tokens, idx, options, env, self);
      };
    });
  }

  /** 找最近的带 data-source-line 的祖先元素。 */
  function findLineAncestor(node) {
    while (node && node.nodeType !== 1) {
      node = node.parentNode;
    }
    while (node && !(node.hasAttribute && node.hasAttribute('data-source-line'))) {
      node = node.parentNode;
    }
    return node;
  }

  /** 拿当前选区对应的源文件行号区间（半开区间，跟 markdown-it token.map 一致）。 */
  function getSelectionLineRange(rootEl) {
    var sel = global.getSelection ? global.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (rootEl && !rootEl.contains(range.commonAncestorContainer)) return null;

    var startEl = findLineAncestor(range.startContainer);
    var endEl = findLineAncestor(range.endContainer);
    if (!startEl || !endEl) return null;

    var startLine = parseInt(startEl.getAttribute('data-source-line'), 10);
    var endLine = parseInt(
      endEl.getAttribute('data-source-line-end') ||
      endEl.getAttribute('data-source-line'),
      10,
    );

    if (Number.isNaN(startLine)) return null;
    if (Number.isNaN(endLine) || endLine <= startLine) {
      var endStart = parseInt(endEl.getAttribute('data-source-line'), 10);
      endLine = Number.isNaN(endStart) ? startLine + 1 : endStart + 1;
    }

    var rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      // 退回到 endEl 的位置
      rect = endEl.getBoundingClientRect();
    }

    return {
      startLine: startLine,
      endLine: endLine,
      text: sel.toString(),
      rect: rect,
      startEl: startEl,
      endEl: endEl,
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 简单 uuid（不依赖 crypto.randomUUID，方便老 webview）。 */
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  global.LectureRenderHelpers = {
    attachSourceLines: attachSourceLines,
    findLineAncestor: findLineAncestor,
    getSelectionLineRange: getSelectionLineRange,
    escapeHtml: escapeHtml,
    uuid: uuid,
  };
})(typeof window !== 'undefined' ? window : globalThis);

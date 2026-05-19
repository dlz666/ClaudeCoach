/**
 * 端到端测试讲义生成 workflow：绕过 sidebar webview，直接调用 lessonPrompt +
 * AIClient.chatCompletion，把结果落盘到 /tmp，便于人工 / 工具分析。
 *
 * 用途：测评"现在的 prompt 让 AI 输出的讲义"实际质量——尤其是：
 *   - AI 服不服从 cc-suggest 占位规则
 *   - widget / mermaid / dot 比例
 *   - 字数 / 结构遵守度
 *   - 引用规范
 *
 * 用法：
 *   node scripts/test-lesson-gen.js [subject] [topicTitle] [lessonTitle] [difficulty]
 * 默认：LLM / Attention 机制 / Multi-Head Self-Attention / 4
 */

// 必须最先加载：mock vscode 模块（patch Module._resolveFilename）
require('./vscode-mock');

const path = require('path');
const fs = require('fs');
const os = require('os');

// 项目根
const ROOT = path.resolve(__dirname, '..');

// 复用编译产物（out/）
const { lessonPrompt } = require(path.join(ROOT, 'out', 'ai', 'prompts.js'));
const { AIClient } = require(path.join(ROOT, 'out', 'ai', 'client.js'));

// 命令行参数
const subject = process.argv[2] || 'LLM 从入门到进阶';
const topicTitle = process.argv[3] || 'Attention 机制详解';
const lessonTitle = process.argv[4] || 'Multi-Head Self-Attention 多头注意力';
const difficulty = parseInt(process.argv[5] || '4', 10);

// 读 profile（用 madou-code GPT-5.5，跟用户日常生成讲义最像）
const profilesPath = path.join(os.homedir(), 'ClaudeCoach', 'app', 'ai', 'profiles.json');
const profilesData = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
const targetProfile = profilesData.profiles.find((p) => p.id === 'profile-1777364267049-ykumyb')
  || profilesData.profiles.find((p) => p.provider === 'openai' && p.apiToken);

if (!targetProfile) {
  console.error('❌ 找不到可用的 OpenAI 兼容 profile');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════');
console.log('  ClaudeCoach 讲义生成 端到端测试');
console.log('═══════════════════════════════════════════════════');
console.log(`  Profile: ${targetProfile.name}`);
console.log(`  Provider: ${targetProfile.provider} / wireApi=${targetProfile.wireApi}`);
console.log(`  Model: ${targetProfile.model}`);
console.log(`  主题: ${subject} → ${topicTitle} → ${lessonTitle}`);
console.log(`  难度: ${difficulty}/5`);
console.log('───────────────────────────────────────────────────');

// 模拟 AIClient 的 config 解析（AIClient 默认从 vscode.workspace 拿配置，
// 测试场景下我们 patch resolveConfig 直接返回 targetProfile）
const aiClient = new AIClient();
// AIClient.getConfig() 看 this.config，存在就返回（绕过 vscode 配置 / profile manager）
// 强制 wireApi=chat_completions（中转 API 通常只支持这个，不支持 OpenAI Responses）
aiClient.config = {
  provider: targetProfile.provider === 'openai-compatible' ? 'openai' : targetProfile.provider,
  baseUrl: targetProfile.baseUrl,
  anthropicBaseUrl: targetProfile.anthropicBaseUrl,
  apiToken: targetProfile.apiToken,
  model: targetProfile.model,
  wireApi: 'chat_completions',
  reasoningEffort: targetProfile.reasoningEffort,
  contextWindow: targetProfile.contextWindow || 128000,
  maxTokens: targetProfile.maxTokens || 8192,
  effectiveBaseUrl: targetProfile.baseUrl,
  profileId: targetProfile.id,
  profileName: targetProfile.name,
  profileSource: 'manual',
  resolvedFrom: 'global',
  warnings: [],
  availableHistoryTokens: 80000,
};

// 用用户真实的 preferences（保证字段齐全跟生产一致）
const prefsPath = path.join(os.homedir(), 'ClaudeCoach', 'app', 'preferences', 'learning.json');
const userPrefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));

// 构造 PromptContext
const ctx = {
  profile: { name: '测试用户', level: 'advanced', goals: ['深入理解 LLM 内部架构'] },
  preferences: userPrefs,
  diagnosis: null,
  currentCourseTitle: subject,
  courseOutlineSummary: '',
  selectedMaterialTitle: '',
  materialSummary: '',
  retrievedExcerpts: [],
  scope: 'lesson-gen',
  courseProfile: null,
  chapterProfile: null,
  profileEvidenceSummary: '',
};

async function main() {
  // 拼讲义 prompt
  const messages = lessonPrompt(subject, topicTitle, lessonTitle, difficulty, ctx);

  console.log(`📋 Prompt 已构造，messages.length = ${messages.length}`);
  console.log(`  system 长度: ${messages[0].content.length} 字符`);
  console.log(`  user: ${messages[1].content.substring(0, 80)}…`);
  console.log('───────────────────────────────────────────────────');

  const startTime = Date.now();
  console.log('⏳ 调用 AI 生成中…\n');

  let buffer = '';
  let lastReportTime = startTime;
  let chunks = 0;

  try {
    const result = await aiClient.chatCompletion(messages, {
      temperature: 0.5,
      onDelta: (chunk) => {
        buffer += chunk;
        chunks += 1;
        // 每 3 秒报一次进度
        const now = Date.now();
        if (now - lastReportTime > 3000) {
          console.log(`  [${((now - startTime) / 1000).toFixed(1)}s] 已输出 ${buffer.length} 字符 / ${chunks} chunks`);
          lastReportTime = now;
        }
      },
    });

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`\n✓ 生成完成 用时 ${elapsed.toFixed(1)}s, 输出 ${result.length} 字符`);

    // 落盘
    const outPath = path.join(os.tmpdir(), `cc-lesson-test-${Date.now()}.md`);
    fs.writeFileSync(outPath, result, 'utf8');
    console.log(`💾 已写入: ${outPath}`);
    console.log('═══════════════════════════════════════════════════');

    // 简单统计
    console.log('\n📊 输出特征统计：');
    console.log(`  总字符数: ${result.length}`);
    console.log(`  中文字数（估算）: ${(result.match(/[一-鿿]/g) || []).length}`);
    console.log(`  cc-suggest 占位: ${(result.match(/<div class="cc-suggest"/g) || []).length} 个`);
    console.log(`    image kind: ${(result.match(/data-kind="image"/g) || []).length}`);
    console.log(`    widget kind: ${(result.match(/data-kind="widget"/g) || []).length}`);
    console.log(`  \`\`\`widget 块: ${(result.match(/```widget/g) || []).length}`);
    console.log(`  \`\`\`mermaid 块: ${(result.match(/```mermaid/g) || []).length}`);
    console.log(`  \`\`\`dot 块: ${(result.match(/```dot/g) || []).length}`);
    console.log(`  公式 $$...$$ 块: ${(result.match(/\$\$/g) || []).length / 2}`);
    console.log(`  行内公式 $...$: ${(result.match(/(?<![$\\])\$[^$]+\$(?!\$)/g) || []).length}`);
    console.log(`  来源引用 [来源 #N]: ${(result.match(/\[来源\s*#\d+\]/g) || []).length}`);
    console.log(`  "想一想：" 引用块: ${(result.match(/想一想[:：]/g) || []).length}`);
    console.log(`  <details> 块: ${(result.match(/<details/g) || []).length}`);
    console.log('═══════════════════════════════════════════════════');

    return outPath;
  } catch (err) {
    console.error('\n❌ AI 调用失败:', err.message || err);
    if (buffer) {
      const outPath = path.join(os.tmpdir(), `cc-lesson-test-FAIL-${Date.now()}.md`);
      fs.writeFileSync(outPath, buffer, 'utf8');
      console.log(`(部分输出已保存到 ${outPath})`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

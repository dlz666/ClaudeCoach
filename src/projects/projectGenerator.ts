import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

import { AIClient } from '../ai/client';
import { projectSpecPrompt } from '../ai/prompts';
import {
  CreateProjectRequest,
  ProjectFileSpec,
  ProjectMeta,
  ProjectScaffoldResult,
  ProjectSpec,
  StudentProfile,
  LearningPreferences,
} from '../types';
import { ensureDir, writeText, fileExists } from '../utils/fileSystem';
import { ProjectStore } from './projectStore';

interface ProjectGenerationContext {
  profile?: StudentProfile | null;
  preferences?: LearningPreferences | null;
  currentCourseTitle?: string;
}

/**
 * 入口：拿 user 的 CreateProjectRequest → AI 出 spec → 写盘 → 返回 ProjectScaffoldResult。
 *
 * 流程：
 *   1. 调 `projectSpecPrompt` 让 AI 出完整 ProjectSpec（含 files / todos / testStrategy）
 *   2. validate spec：必有字段、files 数量 5-20、todos 与 user-stub 数大致匹配
 *   3. 创建项目目录 ~/ClaudeCoach/workspaces/<wsId>/projects/<subject>/<dirName>/
 *   4. 把 spec.files 全写到磁盘（含 README / TODO.md / 测试 / stub）
 *   5. 写 .coach-meta.json 和 .coach-spec.json
 *   6. 更新全局索引 app/projects-index.json
 *   7. 返回 meta + spec
 *
 * 故意不做：
 *   - 不 spawn `claude -p` agent
 *   - 不自动跑测试（user 自己跑）
 *   - 不监听 user 后续改动
 *   - 不做 resume checkpoint
 */
export class ProjectGenerator {
  constructor(private ai: AIClient, private store: ProjectStore) {}

  async createProject(request: CreateProjectRequest, ctx: ProjectGenerationContext = {}): Promise<ProjectScaffoldResult> {
    if (!request.subject?.trim()) {
      return { ok: false, errorMessage: '缺少 subject。' };
    }
    if (!request.prompt?.trim()) {
      return { ok: false, errorMessage: '缺少 prompt（项目想法）。' };
    }

    // ===== Step 1: AI 出 spec =====
    let spec: ProjectSpec;
    try {
      const messages = projectSpecPrompt({
        subject: request.subject,
        userPrompt: request.prompt,
        techStackHint: request.techStackHint,
        linkedCourseTitle: ctx.currentCourseTitle,
        ctx: {
          profile: ctx.profile ?? null,
          preferences: ctx.preferences ?? null,
          currentCourseTitle: ctx.currentCourseTitle,
          scope: 'project-spec',
        },
      });
      spec = await this.ai.chatJson<ProjectSpec>(messages, { temperature: 0.4, maxTokens: 8000 });
    } catch (error) {
      return {
        ok: false,
        errorMessage: `AI 生成 spec 失败：${(error as Error).message}`,
      };
    }

    // ===== Step 2: validate spec =====
    const validation = this.validateSpec(spec);
    if (!validation.ok) {
      return { ok: false, errorMessage: `spec 校验失败：${validation.message}` };
    }

    const warnings: string[] = validation.warnings ?? [];

    // ===== Step 3: 创建项目目录 =====
    const projectId = crypto.randomUUID();
    const dirName = request.dirName?.trim() || this.store.buildDirName(spec.title);
    const projectDir = await this.store.createProjectDir(request.subject, dirName);

    // ===== Step 4: 写所有 spec.files 到磁盘 =====
    try {
      await this.scaffoldFiles(projectDir, spec.files);
    } catch (error) {
      return {
        ok: false,
        errorMessage: `写入项目文件失败：${(error as Error).message}`,
        warnings,
      };
    }

    // ===== 兜底：保证 README + TODO.md 存在（即使 AI 没生成 doc 文件） =====
    await this.ensureReadmeAndTodo(projectDir, spec);

    // ===== Step 5: 写 meta + spec =====
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      id: projectId,
      subject: request.subject,
      title: spec.title,
      description: spec.description,
      status: 'scaffolded',
      createdAt: now,
      updatedAt: now,
      projectDir,
      testCommand: spec.testCommand,
      techStack: spec.techStack,
      hasSpec: true,
      linkedCourse: request.linkedCourse,
      progress: {
        completedTodos: 0,
        totalTodos: spec.todos.length,
        lastUpdated: now,
      },
    };

    await this.store.writeMeta(meta);
    await this.store.writeSpec(request.subject, dirName, spec);

    // ===== Step 6: 索引 =====
    await this.store.upsertIndexEntry({
      id: projectId,
      subject: request.subject,
      dirName,
      createdAt: now,
    });

    return { ok: true, meta, spec, warnings: warnings.length ? warnings : undefined };
  }

  // ===== Helpers =====

  private validateSpec(spec: any): { ok: boolean; message?: string; warnings?: string[] } {
    if (!spec || typeof spec !== 'object') {
      return { ok: false, message: 'spec 不是对象。' };
    }
    if (typeof spec.title !== 'string' || !spec.title.trim()) {
      return { ok: false, message: 'spec.title 缺失。' };
    }
    if (typeof spec.description !== 'string') {
      return { ok: false, message: 'spec.description 缺失。' };
    }
    if (!Array.isArray(spec.files) || spec.files.length === 0) {
      return { ok: false, message: 'spec.files 必须是非空数组。' };
    }
    if (spec.files.length > 15) {
      return { ok: false, message: `spec.files 过多（${spec.files.length}），CS61B 风格要求 3-8 文件聚焦核心，超过 15 拒绝。` };
    }
    if (!Array.isArray(spec.todos)) {
      return { ok: false, message: 'spec.todos 缺失。' };
    }
    if (typeof spec.testCommand !== 'string') {
      return { ok: false, message: 'spec.testCommand 缺失。' };
    }
    if (!Array.isArray(spec.techStack) || spec.techStack.filter((s: any) => typeof s === 'string' && s.trim()).length === 0) {
      return { ok: false, message: 'spec.techStack 必须非空（2-5 项具体技术名）。' };
    }

    const warnings: string[] = [];

    // CS61B 红线检测：
    //   - test-skeleton 含占位测试（it.todo / pytest.skip / 假 assert）
    //   - user-stub 含 step-by-step TODO 注释（"TODO 1:" / "// step 1:" / "第 1 步"）
    const TEST_PLACEHOLDER_PATTERNS: RegExp[] = [
      /\bit\.todo\(/,
      /\btest\.todo\(/,
      /\bit\.skip\(/,
      /\btest\.skip\(/,
      /pytest\.skip\(/,
      /@pytest\.mark\.skip/,
      /expect\(\s*true\s*\)\.toBe\(\s*false\s*\)/,
      /assert\s+False\b/i,
    ];
    const STUB_STEP_TODO_PATTERNS: RegExp[] = [
      /\bTODO\s*\d+\s*[:：]/,
      /#\s*步骤\s*\d+/,
      /\/\/\s*step\s*\d+/i,
      /\/\/\s*第\s*\d+\s*步/,
    ];

    // 检查每个文件
    const seenPaths = new Set<string>();
    const validRoles = new Set(['boilerplate', 'test-skeleton', 'user-stub', 'doc']);
    let hasUserStub = false;
    let hasTestSkeleton = false;
    for (const f of spec.files as ProjectFileSpec[]) {
      if (!f || typeof f.path !== 'string' || !f.path.trim()) {
        return { ok: false, message: '某个 file.path 缺失。' };
      }
      if (typeof f.content !== 'string') {
        return { ok: false, message: `文件 ${f.path} 缺少 content。` };
      }
      if (!validRoles.has(f.role)) {
        return { ok: false, message: `文件 ${f.path} 的 role 非法：${f.role}` };
      }
      const normalizedPath = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (seenPaths.has(normalizedPath)) {
        warnings.push(`重复路径 ${normalizedPath} 已跳过后续。`);
      } else {
        seenPaths.add(normalizedPath);
      }
      // 安全：禁止路径越狱
      if (normalizedPath.includes('..')) {
        return { ok: false, message: `路径越狱：${normalizedPath}` };
      }
      if (f.role === 'user-stub') hasUserStub = true;
      if (f.role === 'test-skeleton') hasTestSkeleton = true;

      // CS61B 红线
      if (f.role === 'test-skeleton') {
        for (const pat of TEST_PLACEHOLDER_PATTERNS) {
          if (pat.test(f.content)) {
            return {
              ok: false,
              message: `测试文件 ${normalizedPath} 含占位测试（匹配 ${pat.source}）。CS61B 风格要求测试是具体可跑的断言，不能用 .todo/.skip/假 assert 占位。`,
            };
          }
        }
      }
      if (f.role === 'user-stub') {
        for (const pat of STUB_STEP_TODO_PATTERNS) {
          if (pat.test(f.content)) {
            return {
              ok: false,
              message: `Stub 文件 ${normalizedPath} 含算法步骤 TODO 注释（匹配 ${pat.source}）。把答案直接喂给学生会毁掉学习 agency，stub 只能有签名 + 一句行为描述。`,
            };
          }
        }
      }
    }

    if (!hasUserStub) {
      warnings.push('spec 里没有 user-stub 文件——意味着 user 没东西可写。');
    }
    if (!hasTestSkeleton) {
      warnings.push('spec 里没有 test-skeleton 文件——TDD 流程需要测试当规约。');
    }
    if (spec.files.length > 10) {
      warnings.push(`spec.files = ${spec.files.length} 偏多，建议合并到 ≤ 8 个文件，聚焦核心交付物。`);
    }

    return { ok: true, warnings };
  }

  private async scaffoldFiles(projectDir: string, files: ProjectFileSpec[]): Promise<void> {
    const written = new Set<string>();
    for (const f of files) {
      const normalized = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (written.has(normalized)) continue;
      written.add(normalized);

      const absPath = path.join(projectDir, normalized);
      // 确保父目录存在
      await ensureDir(path.dirname(absPath));
      await writeText(absPath, f.content);
    }
  }

  /**
   * 如果 AI 没给 README / TODO.md（不属于 'doc' 角色），我们兜底生成最小可读版本，
   * 这样 user 进项目第一眼能看到"我要做什么"。
   */
  private async ensureReadmeAndTodo(projectDir: string, spec: ProjectSpec): Promise<void> {
    const readmePath = path.join(projectDir, 'README.md');
    const todoPath = path.join(projectDir, 'TODO.md');

    if (!(await fileExists(readmePath))) {
      const readme = this.renderDefaultReadme(spec);
      await writeText(readmePath, readme);
    }
    if (!(await fileExists(todoPath))) {
      const todo = this.renderDefaultTodo(spec);
      await writeText(todoPath, todo);
    }
  }

  private renderDefaultReadme(spec: ProjectSpec): string {
    const goals = spec.learningGoals.map((g) => `- ${g}`).join('\n');
    const prereqs = spec.prerequisites.length
      ? spec.prerequisites.map((p) => `- ${p}`).join('\n')
      : '_（无）_';
    const stack = spec.techStack.length ? spec.techStack.join(', ') : '_（无）_';
    return `# ${spec.title}

> ${spec.description}

## 你将学到

${goals}

## 前置知识

${prereqs}

## 技术栈

${stack}

## 怎么开始

1. 在这个目录下用你的包管理器装依赖
2. 跑测试：\`${spec.testCommand}\` — 你会看到一堆 \`it.todo\` / 失败的占位测试
3. 打开 \`TODO.md\`，按顺序实现 user-stub 文件里的函数
4. 每完成一步，再跑测试，看绿
5. 卡住了回 ClaudeCoach 侧边栏问 AI（不要让 AI 替你写实现）

## 验收

${spec.testStrategy}

---
_由 ClaudeCoach 生成的 TDD 学习项目。AI 写测试 + 骨架，你写核心实现。_
`;
  }

  private renderDefaultTodo(spec: ProjectSpec): string {
    const lines: string[] = ['# TODO', '', '按顺序实现下列项。每项都对应一个待实现的文件 + 一组可验证的测试。', ''];
    spec.todos.forEach((t, i) => {
      lines.push(`## ${i + 1}. ${t.description}`);
      lines.push('');
      lines.push(`- **目标文件**：\`${t.targetFile}\``);
      if (t.checkCriteria) lines.push(`- **验收**：${t.checkCriteria}`);
      if (typeof t.difficulty === 'number') lines.push(`- **难度**：${'⭐'.repeat(Math.max(1, Math.min(5, t.difficulty)))}`);
      lines.push('');
      lines.push(`- [ ] 完成`);
      lines.push('');
    });
    return lines.join('\n');
  }
}

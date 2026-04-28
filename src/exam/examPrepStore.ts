import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ExamGradingResult,
  ExamPaperAnalysis,
  ExamPrepSession,
  ExamReadinessSnapshot,
  ExamSubmission,
  ExamVariantSet,
  Subject,
} from '../types';
import { ensureDir, fileExists, listFiles, readJson, writeJson } from '../utils/fileSystem';
import { StoragePathResolver } from '../storage/pathResolver';

interface ExamSessionsIndexEntry {
  sessionId: string;
  subject: Subject;
}

interface ExamSessionsIndex {
  schemaVersion: number;
  entries: ExamSessionsIndexEntry[];
}

const SESSION_SCHEMA_VERSION = 1;
const INDEX_SCHEMA_VERSION = 1;

/**
 * 备考会话存储：会话 CRUD、索引维护、嵌套数据（试卷分析 / 变体题 /
 * 提交）的读写、答题截图落盘。
 *
 * 存储布局：
 *   courses/<subject>/exam-prep/<sessionId>/
 *     session.json
 *     variants/<vsetId>.json
 *     submissions/<subId>/
 *       submission.json
 *       1.png, 2.png, ...
 *
 * 全局索引：appDir/exam-sessions-index.json，存 { sessionId, subject }，
 * 让 listExamSessions 不必扫所有 subject 目录。
 */
export class ExamPrepStore {
  constructor(private readonly paths: StoragePathResolver) {}

  // ======================================================================
  // 索引
  // ======================================================================

  private async readIndex(): Promise<ExamSessionsIndex> {
    const stored = await readJson<ExamSessionsIndex>(this.paths.examSessionsIndexPath);
    if (stored && Array.isArray(stored.entries)) {
      return {
        schemaVersion: stored.schemaVersion ?? INDEX_SCHEMA_VERSION,
        entries: stored.entries.filter((e) => e && e.sessionId && e.subject),
      };
    }
    return { schemaVersion: INDEX_SCHEMA_VERSION, entries: [] };
  }

  private async writeIndex(index: ExamSessionsIndex): Promise<void> {
    await writeJson(this.paths.examSessionsIndexPath, index);
  }

  private async addToIndex(sessionId: string, subject: Subject): Promise<void> {
    const index = await this.readIndex();
    if (!index.entries.find((e) => e.sessionId === sessionId)) {
      index.entries.push({ sessionId, subject });
      await this.writeIndex(index);
    }
  }

  private async removeFromIndex(sessionId: string): Promise<void> {
    const index = await this.readIndex();
    const before = index.entries.length;
    index.entries = index.entries.filter((e) => e.sessionId !== sessionId);
    if (index.entries.length !== before) {
      await this.writeIndex(index);
    }
  }

  // ======================================================================
  // 会话 CRUD
  // ======================================================================

  async createSession(args: {
    subject: Subject;
    name: string;
    examDate?: string;
    sourcePaperIds: string[];
  }): Promise<ExamPrepSession> {
    const id = `exam-${Date.now()}`;
    const now = new Date().toISOString();
    const session: ExamPrepSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      subject: args.subject,
      name: args.name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      examDate: args.examDate,
      sourcePaperIds: Array.from(new Set(args.sourcePaperIds || [])),
      paperAnalyses: [],
      variantSets: [],
      submissions: [],
    };
    await this.saveSession(session);
    await this.addToIndex(id, args.subject);
    return session;
  }

  async getSession(sessionId: string): Promise<ExamPrepSession | null> {
    const index = await this.readIndex();
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (!entry) {
      // 兜底：扫盘（极慢路径，仅在索引丢失时）
      return this.findSessionWithoutIndex(sessionId);
    }
    return this.loadSession(entry.subject, sessionId);
  }

  private async loadSession(subject: Subject, sessionId: string): Promise<ExamPrepSession | null> {
    const file = this.paths.examSessionMetaPath(subject, sessionId);
    const stored = await readJson<ExamPrepSession>(file);
    if (!stored) return null;
    return {
      ...stored,
      schemaVersion: stored.schemaVersion ?? SESSION_SCHEMA_VERSION,
      paperAnalyses: stored.paperAnalyses ?? [],
      variantSets: stored.variantSets ?? [],
      submissions: stored.submissions ?? [],
    };
  }

  private async findSessionWithoutIndex(sessionId: string): Promise<ExamPrepSession | null> {
    // 兜底：根据已知的全局索引位置无法定位时，扫遍 examPrepSubjectDir。
    // 需要 subject 列表——从 workspaceCoursesDir 扫子目录。
    try {
      const coursesDir = this.paths.workspaceCoursesDir;
      const entries = await fs.readdir(coursesDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const subject = e.name;
        const candidate = this.paths.examSessionMetaPath(subject, sessionId);
        if (await fileExists(candidate)) {
          await this.addToIndex(sessionId, subject);
          return this.loadSession(subject, sessionId);
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  async saveSession(session: ExamPrepSession): Promise<void> {
    const next: ExamPrepSession = {
      ...session,
      schemaVersion: session.schemaVersion ?? SESSION_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    const file = this.paths.examSessionMetaPath(session.subject, session.id);
    await writeJson(file, next);
  }

  async listSessions(subject?: Subject): Promise<ExamPrepSession[]> {
    const index = await this.readIndex();
    const candidates = subject
      ? index.entries.filter((e) => e.subject === subject)
      : index.entries;
    const out: ExamPrepSession[] = [];
    for (const entry of candidates) {
      const session = await this.loadSession(entry.subject, entry.sessionId);
      if (session) {
        out.push(session);
      }
    }
    // 按 updatedAt 倒序
    out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return out;
  }

  async archiveSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;
    session.status = 'archived';
    await this.saveSession(session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      await this.removeFromIndex(sessionId);
      return;
    }
    const dir = this.paths.examSessionDir(session.subject, sessionId);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await this.removeFromIndex(sessionId);
  }

  // ======================================================================
  // 试卷分析
  // ======================================================================

  async addPaperAnalysis(sessionId: string, analysis: ExamPaperAnalysis): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`exam session not found: ${sessionId}`);
    // 同 paperId 替换，不存在则追加
    const idx = session.paperAnalyses.findIndex((a) => a.paperId === analysis.paperId);
    if (idx >= 0) {
      session.paperAnalyses[idx] = analysis;
    } else {
      session.paperAnalyses.push(analysis);
    }
    if (!session.sourcePaperIds.includes(analysis.paperId)) {
      session.sourcePaperIds.push(analysis.paperId);
    }
    await this.saveSession(session);
  }

  // ======================================================================
  // 变体题集
  // ======================================================================

  async addVariantSet(sessionId: string, set: ExamVariantSet): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`exam session not found: ${sessionId}`);
    // 详细数据写到 variants/<vsetId>.json；session.json 里只存"瘦身"版引用
    const file = this.paths.examSessionVariantSetPath(session.subject, sessionId, set.id);
    await writeJson(file, set);
    const idx = session.variantSets.findIndex((s) => s.id === set.id);
    if (idx >= 0) {
      session.variantSets[idx] = set;
    } else {
      session.variantSets.push(set);
    }
    await this.saveSession(session);
  }

  async getVariantSet(sessionId: string, variantSetId: string): Promise<ExamVariantSet | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    // 优先磁盘文件
    const file = this.paths.examSessionVariantSetPath(session.subject, sessionId, variantSetId);
    const stored = await readJson<ExamVariantSet>(file);
    if (stored) return stored;
    // 兜底：从 session.variantSets 拿
    return session.variantSets.find((v) => v.id === variantSetId) ?? null;
  }

  // ======================================================================
  // 提交
  // ======================================================================

  async addSubmission(sessionId: string, submission: ExamSubmission): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`exam session not found: ${sessionId}`);
    const file = this.paths.examSessionSubmissionPath(session.subject, sessionId, submission.id);
    await writeJson(file, submission);
    const idx = session.submissions.findIndex((s) => s.id === submission.id);
    if (idx >= 0) {
      session.submissions[idx] = submission;
    } else {
      session.submissions.push(submission);
    }
    await this.saveSession(session);
  }

  async updateSubmissionGrading(
    sessionId: string,
    submissionId: string,
    grading: ExamGradingResult,
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`exam session not found: ${sessionId}`);
    const sub = session.submissions.find((s) => s.id === submissionId);
    if (!sub) throw new Error(`submission not found: ${submissionId}`);
    sub.gradingResult = grading;
    const file = this.paths.examSessionSubmissionPath(session.subject, sessionId, submissionId);
    await writeJson(file, sub);
    await this.saveSession(session);
  }

  async updateReadiness(sessionId: string, snapshot: ExamReadinessSnapshot): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`exam session not found: ${sessionId}`);
    session.latestReadiness = snapshot;
    await this.saveSession(session);
  }

  // ======================================================================
  // 图片落盘
  // ======================================================================

  /**
   * 把图片写入 submissions/<subId>/<name>，返回绝对路径。
   *
   * 支持两种调用形式：
   *   1. saveSubmissionImage(sessionId, submissionId, { name, mimeType, base64 })
   *   2. saveSubmissionImage(sessionId, submissionId, fileName, buffer)
   *
   * 第二种是 examWebviewProvider 已经在用的"低层"形式，本仓库其他地方都用第一种。
   */
  async saveSubmissionImage(
    sessionId: string,
    submissionId: string,
    imageDataOrFileName: { name: string; mimeType: string; base64: string } | string,
    rawBuffer?: Buffer,
  ): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`exam session not found: ${sessionId}`);
    const dir = this.paths.examSessionSubmissionDir(session.subject, sessionId, submissionId);
    await ensureDir(dir);

    let safeName: string;
    let buf: Buffer;
    if (typeof imageDataOrFileName === 'string') {
      if (!rawBuffer) throw new Error('saveSubmissionImage: 第 4 参数 buffer 缺失。');
      safeName = sanitizeImageFileName(imageDataOrFileName, 'image/png');
      buf = rawBuffer;
    } else {
      safeName = sanitizeImageFileName(imageDataOrFileName.name, imageDataOrFileName.mimeType);
      buf = Buffer.from(imageDataOrFileName.base64, 'base64');
    }

    const filePath = this.paths.examSessionSubmissionImagePath(
      session.subject,
      sessionId,
      submissionId,
      safeName,
    );
    await fs.writeFile(filePath, buf);
    return filePath;
  }

  /** 公开给 SidebarProvider 使用：列出某 session 下已落盘的图片名（用于回放/调试）。 */
  async listSubmissionImages(sessionId: string, submissionId: string): Promise<string[]> {
    const session = await this.getSession(sessionId);
    if (!session) return [];
    const dir = this.paths.examSessionSubmissionDir(session.subject, sessionId, submissionId);
    const files = await listFiles(dir);
    return files
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => path.join(dir, f));
  }
}

function sanitizeImageFileName(rawName: string, mimeType: string): string {
  const base = (rawName || 'image').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'image';
  if (/\.(png|jpe?g|webp)$/i.test(base)) return base;
  const ext =
    mimeType === 'image/jpeg' ? '.jpg'
      : mimeType === 'image/webp' ? '.webp'
        : '.png';
  return `${base}${ext}`;
}

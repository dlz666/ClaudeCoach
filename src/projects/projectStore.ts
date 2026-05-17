import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectMeta, ProjectSpec, ProjectStatus } from '../types';
import { readJson, writeJson, ensureDir, fileExists } from '../utils/fileSystem';
import { getStoragePathResolver, sanitizeSegment, StoragePathResolver } from '../storage/pathResolver';

/**
 * 全局项目索引：`app/projects-index.json`。
 *   - 让 listProjects 不必扫所有 subject 目录
 *   - projectId 全局唯一
 *   - 每条记录最少信息：id / subject / dirName，meta 详情仍在每个项目目录里
 */
interface ProjectsIndex {
  version: number;
  /** projectId → { subject, dirName, createdAt } */
  entries: Array<{
    id: string;
    subject: string;
    dirName: string;
    createdAt: string;
  }>;
}

const INDEX_VERSION = 1;

/**
 * Project 元数据 / spec / 索引的统一访问层。
 *
 * 职责：
 *   - 创建项目目录
 *   - 读写 .coach-meta.json（ProjectMeta）
 *   - 读写 .coach-spec.json（ProjectSpec）
 *   - 维护全局索引（app/projects-index.json）
 *
 * 不职责：
 *   - 生成 spec 内容（→ projectGenerator.ts）
 *   - 写入 boilerplate / test / stub 文件（→ projectGenerator.ts）
 *   - 跑测试（→ user 自己跑，本模块不管）
 */
export class ProjectStore {
  private readonly paths: StoragePathResolver;

  constructor(paths?: StoragePathResolver) {
    this.paths = paths ?? getStoragePathResolver();
  }

  // ===== 索引 =====

  async readIndex(): Promise<ProjectsIndex> {
    const data = await readJson<ProjectsIndex>(this.paths.projectsIndexPath);
    if (!data || data.version !== INDEX_VERSION) {
      return { version: INDEX_VERSION, entries: [] };
    }
    return data;
  }

  async writeIndex(index: ProjectsIndex): Promise<void> {
    await writeJson(this.paths.projectsIndexPath, index);
  }

  async upsertIndexEntry(entry: { id: string; subject: string; dirName: string; createdAt: string }): Promise<void> {
    const index = await this.readIndex();
    const i = index.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      index.entries[i] = entry;
    } else {
      index.entries.push(entry);
    }
    await this.writeIndex(index);
  }

  async removeIndexEntry(projectId: string): Promise<void> {
    const index = await this.readIndex();
    const next = index.entries.filter((e) => e.id !== projectId);
    if (next.length !== index.entries.length) {
      await this.writeIndex({ ...index, entries: next });
    }
  }

  // ===== 路径辅助 =====

  /**
   * 由 user 给的 title 推一个磁盘目录名（去中文 / 特殊字符 / 加短随机后缀防冲突）。
   * 例：title "Implement minimal SSM in PyTorch" → "implement-minimal-ssm-in-pytorch-a3b9"
   */
  buildDirName(title: string): string {
    const slug = sanitizeSegment(title, 'project');
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${slug}-${suffix}`;
  }

  /** 从索引解析 projectId → 目录信息，找不到返回 null。 */
  async resolveProjectLocation(projectId: string): Promise<{ subject: string; dirName: string; projectDir: string } | null> {
    const index = await this.readIndex();
    const entry = index.entries.find((e) => e.id === projectId);
    if (!entry) return null;
    return {
      subject: entry.subject,
      dirName: entry.dirName,
      projectDir: this.paths.projectDir(entry.subject, entry.dirName),
    };
  }

  // ===== 目录 =====

  async createProjectDir(subject: string, dirName: string): Promise<string> {
    const dir = this.paths.projectDir(subject, dirName);
    await ensureDir(dir);
    return dir;
  }

  // ===== Meta =====

  async writeMeta(meta: ProjectMeta): Promise<void> {
    const dir = this.paths.projectDir(meta.subject, path.basename(meta.projectDir));
    await ensureDir(dir);
    await writeJson(this.paths.projectMetaPath(meta.subject, path.basename(meta.projectDir)), meta);
  }

  async readMeta(subject: string, dirName: string): Promise<ProjectMeta | null> {
    return readJson<ProjectMeta>(this.paths.projectMetaPath(subject, dirName));
  }

  async readMetaByProjectId(projectId: string): Promise<ProjectMeta | null> {
    const loc = await this.resolveProjectLocation(projectId);
    if (!loc) return null;
    return this.readMeta(loc.subject, loc.dirName);
  }

  // ===== Spec =====

  async writeSpec(subject: string, dirName: string, spec: ProjectSpec): Promise<void> {
    await writeJson(this.paths.projectSpecPath(subject, dirName), spec);
  }

  async readSpec(subject: string, dirName: string): Promise<ProjectSpec | null> {
    return readJson<ProjectSpec>(this.paths.projectSpecPath(subject, dirName));
  }

  async readSpecByProjectId(projectId: string): Promise<ProjectSpec | null> {
    const loc = await this.resolveProjectLocation(projectId);
    if (!loc) return null;
    return this.readSpec(loc.subject, loc.dirName);
  }

  // ===== 列表 / 更新 / 删除 =====

  async listAll(subjectFilter?: string): Promise<ProjectMeta[]> {
    const index = await this.readIndex();
    const filtered = subjectFilter
      ? index.entries.filter((e) => e.subject === subjectFilter)
      : index.entries;

    const metas: ProjectMeta[] = [];
    for (const e of filtered) {
      const meta = await this.readMeta(e.subject, e.dirName);
      if (meta) metas.push(meta);
    }
    // 最新创建在前
    metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return metas;
  }

  async updateProgress(projectId: string, completedTodos: number, status?: ProjectStatus): Promise<ProjectMeta | null> {
    const meta = await this.readMetaByProjectId(projectId);
    if (!meta) return null;
    const totalTodos = meta.progress?.totalTodos ?? 0;
    const nextMeta: ProjectMeta = {
      ...meta,
      updatedAt: new Date().toISOString(),
      status: status ?? meta.status,
      progress: {
        completedTodos: Math.max(0, Math.min(completedTodos, totalTodos)),
        totalTodos,
        lastUpdated: new Date().toISOString(),
      },
    };
    await this.writeMeta(nextMeta);
    return nextMeta;
  }

  /**
   * 删除项目。
   *   - `purgeFiles=false`：仅删索引 + .coach-meta.json + .coach-spec.json，
   *     user 的代码留着。
   *   - `purgeFiles=true`：递归 rm 整个项目目录（destructive，调用方需 confirm）。
   */
  async deleteProject(projectId: string, opts: { purgeFiles?: boolean } = {}): Promise<{ ok: boolean; removedDir?: string }> {
    const loc = await this.resolveProjectLocation(projectId);
    if (!loc) return { ok: false };

    const dir = loc.projectDir;
    if (opts.purgeFiles) {
      if (await fileExists(dir)) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } else {
      // 只删元数据 + spec，留用户代码
      const metaPath = this.paths.projectMetaPath(loc.subject, loc.dirName);
      const specPath = this.paths.projectSpecPath(loc.subject, loc.dirName);
      if (await fileExists(metaPath)) await fs.unlink(metaPath);
      if (await fileExists(specPath)) await fs.unlink(specPath);
    }

    await this.removeIndexEntry(projectId);
    return { ok: true, removedDir: dir };
  }
}

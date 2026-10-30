/**
 * MAERS GitHub Sync Driver (github-sync.module.js)
 * 职责：通过 GitHub REST API (Git Data API) 实现纯前端原子化提交
 * 无需任何外部 npm 依赖，支持移动端直接操作
 * @version 1.0.0
 */

import { Toast } from '../../shared/toast.module.js';

export class GitHubSyncDriver {
    constructor() {
        this.apiBase = 'https://api.github.com';
    }

    /**
     * 构建请求头
     * @param {string} token - GitHub Personal Access Token
     */
    _getHeaders(token) {
        return {
            'Authorization': `Bearer ${token.trim()}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        };
    }

    /**
     * 测试 GitHub 仓库连接与 Token 权限
     * @param {string} token 
     * @param {string} repo - 格式: owner/repo
     */
    async testConnection(token, repo) {
        if (!token || !repo) {
            return { success: false, msg: 'Token 与仓库名称不可为空' };
        }

        try {
            const res = await fetch(`${this.apiBase}/repos/${repo.trim()}`, {
                headers: this._getHeaders(token)
            });

            if (res.ok) {
                const data = await res.json();
                return {
                    success: true,
                    repoName: data.full_name,
                    permissions: data.permissions,
                    defaultBranch: data.default_branch
                };
            } else if (res.status === 401) {
                return { success: false, msg: 'Token 无效或已过期 (401 Unauthorized)' };
            } else if (res.status === 404) {
                return { success: false, msg: '仓库未找到，请检查仓库名及 Token 权限 (404 Not Found)' };
            } else {
                const err = await res.text();
                return { success: false, msg: `连接错误 (${res.status}): ${err}` };
            }
        } catch (e) {
            console.error('[GitHubSync] Test connection error:', e);
            return { success: false, msg: `网络请求失败: ${e.message}` };
        }
    }

    /**
     * 原子化批量提交文件变更 (Git Data API)
     * 支持在单次 Commit 中同时更新 Markdown 文件与 Tree 索引 JSON
     * 
     * @param {Object} options
     * @param {string} options.token - GitHub Token
     * @param {string} options.repo - owner/repo
     * @param {string} options.branch - 分支名 (默认 main)
     * @param {Array<{path: string, content: string, encoding?: string}>} options.files - 变更文件列表
     * @param {string} options.message - 提交说明
     * @returns {Promise<{success: boolean, commitSha?: string, msg?: string}>}
     */
    async commitFiles({ token, repo, branch = 'main', files = [], message = 'Update content via MAERS Mobile' }) {
        if (!token || !repo || !files.length) {
            return { success: false, msg: '缺少必要参数 (Token / Repo / Files)' };
        }

        const headers = this._getHeaders(token);
        const cleanRepo = repo.trim();
        const cleanBranch = branch.trim();

        try {
            // 步骤 1：获取分支最新 Commit SHA
            const refRes = await fetch(`${this.apiBase}/repos/${cleanRepo}/git/ref/heads/${cleanBranch}`, { headers });
            if (!refRes.ok) {
                throw new Error(`获取分支失败 (${refRes.status}): 无法找到分支 ${cleanBranch}`);
            }
            const refData = await refRes.json();
            const latestCommitSha = refData.object.sha;

            // 步骤 2：获取最新 Commit 的 Tree SHA
            const commitRes = await fetch(`${this.apiBase}/repos/${cleanRepo}/git/commits/${latestCommitSha}`, { headers });
            if (!commitRes.ok) {
                throw new Error(`获取提交记录失败 (${commitRes.status})`);
            }
            const commitData = await commitRes.json();
            const baseTreeSha = commitData.tree.sha;

            // 步骤 3：构建 Tree 节点（支持处理 UTF-8 文本和 Base64 二进制）
            const treeEntries = [];
            for (const file of files) {
                if (file.encoding === 'base64') {
                    // 二进制文件（如图片），需要先单独创建 Blob
                    const blobRes = await fetch(`${this.apiBase}/repos/${cleanRepo}/git/blobs`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            content: file.content,
                            encoding: 'base64'
                        })
                    });
                    if (!blobRes.ok) throw new Error(`上传附件 Blob 失败: ${file.path}`);
                    const blobData = await blobRes.json();
                    treeEntries.push({
                        path: file.path.replace(/^\/+/, ''),
                        mode: '100644',
                        type: 'blob',
                        sha: blobData.sha
                    });
                } else {
                    // 纯文本文件（Markdown、JSON），直接写入 tree 节点内容
                    treeEntries.push({
                        path: file.path.replace(/^\/+/, ''),
                        mode: '100644',
                        type: 'blob',
                        content: file.content
                    });
                }
            }

            // 步骤 4：在 base_tree 基础上创建新的 Tree
            const treeRes = await fetch(`${this.apiBase}/repos/${cleanRepo}/git/trees`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    base_tree: baseTreeSha,
                    tree: treeEntries
                })
            });
            if (!treeRes.ok) {
                const errText = await treeRes.text();
                throw new Error(`创建 Git Tree 失败 (${treeRes.status}): ${errText}`);
            }
            const newTreeData = await treeRes.json();

            // 步骤 5：创建 Commit
            const newCommitRes = await fetch(`${this.apiBase}/repos/${cleanRepo}/git/commits`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    message: message,
                    tree: newTreeData.sha,
                    parents: [latestCommitSha]
                })
            });
            if (!newCommitRes.ok) {
                const errText = await newCommitRes.text();
                throw new Error(`创建 Commit 失败 (${newCommitRes.status}): ${errText}`);
            }
            const newCommitData = await newCommitRes.json();

            // 步骤 6：更新分支 Ref (指向新 Commit)
            const updateRefRes = await fetch(`${this.apiBase}/repos/${cleanRepo}/git/refs/heads/${cleanBranch}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({
                    sha: newCommitData.sha,
                    force: false
                })
            });
            if (!updateRefRes.ok) {
                const errText = await updateRefRes.text();
                throw new Error(`更新分支指针失败 (${updateRefRes.status}): ${errText}`);
            }

            return {
                success: true,
                commitSha: newCommitData.sha
            };
        } catch (e) {
            console.error('[GitHubSync] Commit failed:', e);
            return {
                success: false,
                msg: e.message
            };
        }
    }
}

export const githubSync = new GitHubSyncDriver();

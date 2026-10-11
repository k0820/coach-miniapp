# GitHub 安全交接说明

## 文档来源

仓库根目录的 `AGENTS.md`、`CURRENT_HANDOFF.md`、`PROJECT_MEMORY.md`、`REUSABLE_SKILLS.md` 和 `PERMANENT_TEST_INDEX.md` 是从项目所有者本机完整文档提炼的脱敏副本。

原始文档没有被修改或删除。原始病历含真实业务记录，因此不会上传 GitHub。

## 新协作者读取方式

1. 克隆仓库后先读 `AGENTS.md`。
2. 再按其中顺序阅读其余四份文档。
3. 当前事实以 `CURRENT_HANDOFF.md` 为准，历史原则以 `PROJECT_MEMORY.md` 为准。
4. 需要旧事故细节时，只向项目所有者索取最少必要的脱敏片段。

## 仓库不包含

- 真实会员资料、真实课程明细、费用和收入快照。
- 数据库导出、云端下载、备份和恢复点。
- AppSecret、Token、私钥和本机微信开发者工具配置。
- `node_modules`、运行日志、上传日志、探针输出和截图。
- 1 份包含真实事故姓名和具体课程时间的本地回归测试；文件未删除，只被 GitHub 忽略。
- `pkg-diag/repair-orphan-tombstone/` 真实事故救援工具；其中含真实事件信息，本机原件保留，GitHub 不上传。

## 协作限制

- 所有修改走独立分支和 Pull Request。
- 不允许直接推送或强制推送主分支。
- 未经项目所有者授权，不部署云函数、不上传体验版、不提交审核、不操作 Production。


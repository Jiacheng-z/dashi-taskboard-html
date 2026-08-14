function renderComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return "（暂无评论）";
  return comments
    .map((comment, index) => {
      const who = comment.authorName?.trim() || "未署名";
      const when = comment.createdAt ?? "";
      const body = comment.body?.trim() || "（空评论）";
      return `${index + 1}. [${who} ${when}]\n${body}`;
    })
    .join("\n\n");
}

function renderRules(id, taskctlCommand) {
  return [
    "",
    "## 硬约束（违反即视为本次执行失败）",
    "1. **禁止任何 git 写操作**：不得执行 git commit、git add、git stash、git checkout、git reset、git rebase、git merge、git push，也不得用其他命令间接达成同样效果。"
      + "使用者的工作区长期是脏的，一次 `git add -A` 会把他没写完的改动一起提交。只读的 git status、git diff、git log 可以用来看现状。",
    "2. **「改了什么」必须你自己逐条记录，不许从 `git diff` 推导**：这个目录里同时混着使用者的改动和别的 agent 的改动，"
      + "`git diff` 的内容归不到你头上。边做边记下你实际编辑过的文件与改动点，收尾时照记录写。",
    "",
    "## 收尾（必须做，否则任务会被 scheduler 判为未完成）",
    `1. 写评论：${taskctlCommand} comment add ${id} --body "<关键改动、验证方式与结果、剩余风险>"`,
    `2. 读最新版本号：${taskctlCommand} issue get ${id} --json`,
    `3. 用该版本号移状态：${taskctlCommand} issue move ${id} --status in_review --if-version <version>`,
    "",
    "议题已经由 scheduler 认领并置为 in_progress，你不需要也不应该再改成 in_progress。",
    "只能移到 in_review，不要直接标记为 done —— done 由使用者确认后自己点。",
    "如果你判断这件事做不了或需要使用者补充信息，同样走上面三步：把原因写进评论，再移到 in_review。",
  ];
}

export function buildAgentTaskPrompt({ task, comments, project, skillPath, taskctlCommand }) {
  const id = task.identifier;
  return [
    `[$manage-taskboard](${skillPath}) e-taskboard`,
    `你正在处理任务面板「${project.name}」（项目 ID：${project.id}）里的议题 ${id}。`,
    `项目目录：${project.workspacePath ?? "（未配置，按当前工作目录处理）"}`,
    `本轮所有 taskctl 操作都使用完整命令前缀 ${taskctlCommand}，不要使用 PATH 中的 taskctl。`,
    "",
    `## 议题 ${id}：${task.title}`,
    task.description?.trim() || "（无描述）",
    "",
    "## 已有评论（含可能的返工要求，按时间正序）",
    renderComments(comments),
  ].concat(renderRules(id, taskctlCommand)).join("\n");
}

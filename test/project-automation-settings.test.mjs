import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const menuSource = await readFile(
  new URL("../web/src/components/ProjectAutomationMenu.tsx", import.meta.url),
  "utf8",
);
const iconSource = await readFile(
  new URL("../web/src/components/TaskboardIcon.tsx", import.meta.url),
  "utf8",
);
const playIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-play.svg", import.meta.url),
  "utf8",
);
const pauseIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-pause.svg", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("project automation state comes from the server, not device storage or the Codex host", () => {
  assert.doesNotMatch(appSource, /PROJECT_AUTOMATIONS_KEY/);
  assert.doesNotMatch(appSource, /taskboard:automation-request/);
  assert.doesNotMatch(appSource, /taskboard:automation-response/);
  assert.doesNotMatch(appSource, /quotaAware/);
  assert.doesNotMatch(appSource, /taskboard-automation-options/);
  assert.doesNotMatch(appSource, /intervalMinutesFromRrule|isAutomationHostItem|isAutomationHostPolicy/);
  assert.match(appSource, /getProjectAutomation\(selectedProjectId\)/);
  assert.match(appSource, /updateProjectAutomation\(selectedProjectId, changes\)/);
  assert.match(appSource, /getAiChatCatalog\(selectedProjectId\)/);
  assert.match(appSource, /models=\{automationModels\}/);
});

test("the project navigation automation menu owns the icon, fields, and accessible popover", () => {
  assert.match(menuSource, /status === "ACTIVE" \? "automationPause" : "automationPlay"/);
  assert.doesNotMatch(menuSource, /statusStarted|statusTodo/);
  assert.match(menuSource, /aria-busy=\{pending/);
  assert.match(menuSource, /自动认领/);
  assert.match(menuSource, /aria-label=\{status === "ACTIVE"\s*\? text\("自动认领中", "Auto-claiming"\)\s*: text\("自动化", "Automation"\)\}/);
  assert.doesNotMatch(menuSource, /已开启自动认领|自动认领未开启/);
  assert.match(menuSource, /自动认领开关/);
  assert.match(menuSource, /5, 10, 15, 30, 60/);
  assert.match(menuSource, /models\.map/);
  assert.match(menuSource, /EFFORT_LABELS\[effort\]/);
  assert.match(menuSource, /createPortal/);
  assert.match(menuSource, /window\.addEventListener\("resize"/);
  assert.match(menuSource, /window\.addEventListener\("scroll", closeFromViewportChange, true\)/);
  assert.match(menuSource, /no-drag/);
  assert.doesNotMatch(menuSource, /event\.key === "Tab"/);
  assert.match(appSource, /<ProjectAutomationMenu/);
  assert.match(appSource, /<ProjectAutomationMenu[\s\S]*?<button[\s\S]*?header-create-button/);
  assert.doesNotMatch(appSource, /toolbar-connection/);
  assert.match(appSource, /仅本地任务面板可用/);
});

test("automation status uses the exported Taskboard play and pause icon assets", () => {
  assert.match(iconSource, /import automationPause from "\.\.\/assets\/figma-taskboard\/automation-pause\.svg"/);
  assert.match(iconSource, /import automationPlay from "\.\.\/assets\/figma-taskboard\/automation-play\.svg"/);
  assert.match(iconSource, /const TASKBOARD_ICONS = \{[\s\S]*?automationPause,[\s\S]*?automationPlay,/);
});

test("automation play and pause retain the exported 16px presentation", () => {
  assert.match(playIcon, /width="16" height="16" viewBox="0 0 16 16"/);
  assert.match(pauseIcon, /width="16" height="16" viewBox="0 0 16 16"/);
});

test("the automation menu reuses the board switches and keeps form focus chrome suppressed", () => {
  assert.match(menuSource, /className=\{`board-setting-switch\$\{draft\.enabledByUser \? " is-on" : ""\}`\}/);
  assert.match(menuSource, /role="switch"/);
  assert.match(menuSource, /aria-checked=\{draft\.enabledByUser\}/);
  assert.doesNotMatch(menuSource, /quotaAware/);
  assert.doesNotMatch(menuSource, /taskboard-automation-options/);
  assert.doesNotMatch(menuSource, /gpt-5\.5/);
  assert.match(menuSource, /models: AiChatModel\[\]/);
  assert.doesNotMatch(menuSource, /type="checkbox"/);
  assert.match(styles, /\.project-automation-field select:focus-visible\s*\{[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(styles, /\.project-automation-switch input:focus-visible/);
});

test("unavailable automation state has one notice, clears stale errors, and cannot change", () => {
  assert.match(menuSource, /error && error !== unavailableReason/);
  assert.match(menuSource, /const disabled = pending \|\| Boolean\(unavailableReason\)/);
  assert.equal(menuSource.match(/disabled=\{disabled\}/g)?.length, 4);
  assert.match(appSource, /if \(automationUnavailableReason \|\| !selectedProjectId\) return;/);
  assert.match(appSource, /const automationUnavailableReason = useMemo\(/);
});

test("automation changes submit immediately with model-specific effort normalization", () => {
  assert.match(menuSource, /onChange: \(options: AutomationOptions\) => void/);
  assert.match(menuSource, /const disabled = pending \|\| Boolean\(unavailableReason\)/);
  assert.match(menuSource, /const submitChange = \(next: AutomationOptions\) => \{[\s\S]*?setDraft\(next\);[\s\S]*?onChange\(next\);[\s\S]*?\}/);
  assert.match(
    menuSource,
    /submitChange\(\{ \.\.\.draft, model: event\.target\.value \|\| null, reasoningEffort: null \}\)/,
  );
  assert.match(menuSource, /supportedReasoningEfforts/);
  assert.match(menuSource, /defaultReasoningEffort/);
  assert.doesNotMatch(menuSource, /withAutomationModel|getAutomationModel/);
  assert.match(menuSource, /low: \["轻度", "Low"\]/);
  assert.match(menuSource, /xhigh: \["极高 \(xhigh\)", "Extra high \(xhigh\)"\]/);
  assert.match(menuSource, /max: \["最高", "Maximum"\]/);
  assert.match(menuSource, /ultra: \["极高 \(ultra\)", "Ultra"\]/);
  assert.doesNotMatch(menuSource, />取消</);
  assert.doesNotMatch(menuSource, />保存</);
  assert.doesNotMatch(menuSource, /project-automation-actions/);
  assert.doesNotMatch(menuSource, /onSave/);
  assert.doesNotMatch(styles, /\.project-automation-actions/);
});

test("pending completion reconciles the optimistic draft to confirmed host state", () => {
  assert.match(menuSource, /const wasPendingRef = useRef\(pending\)/);
  assert.match(
    menuSource,
    /if \(wasPendingRef\.current && !pending\) \{\s*setDraft\(\{ \.\.\.DEFAULT_OPTIONS, \.\.\.automation \}\);\s*\}/,
  );
  assert.match(menuSource, /wasPendingRef\.current = pending/);
  assert.match(menuSource, /disabled=\{disabled\}/);
});

test("自动化配置走 HTTP 接口而不是 host message", async () => {
  const apiText = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
  assert.match(apiText, /export async function getProjectAutomation\(/);
  assert.match(apiText, /export async function updateProjectAutomation\(/);
  assert.match(apiText, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/automation/);
  assert.match(apiText, /method: "PATCH"/);
  const typesText = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
  assert.match(typesText, /export interface ProjectAutomation \{/);
  for (const field of ["enabledByUser", "intervalMinutes", "model", "reasoningEffort"]) {
    assert.match(typesText, new RegExp(`${field}:`));
  }
  assert.doesNotMatch(typesText, /quotaAware/);
});

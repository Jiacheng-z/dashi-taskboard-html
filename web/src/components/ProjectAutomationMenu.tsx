import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import type { AiChatModel } from "../types";

type AutomationStatus = "ACTIVE" | "PAUSED";

export interface AutomationOptions {
  enabledByUser: boolean;
  intervalMinutes: number;
  /** null = 跟随所选后端的默认模型，不写死 slug */
  model: string | null;
  /** null = 跟随所选模型的 defaultReasoningEffort */
  reasoningEffort: string | null;
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationOptions>;
  models: AiChatModel[];
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  intervalMinutes: 5,
  model: null,
  reasoningEffort: null,
};

// 各后端的强度取值不是同一套（codex 六档、ducc 目前只有 medium），
// 所以这张表是「已知取值的中文名」而非枚举，未知取值原样显示。
const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};

export function ProjectAutomationMenu({
  automation,
  models,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const { text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  // 原来的 status 来自 codex app 的 automation item，脱离 app 后没有这个信息源，
  // 唯一真源就是用户自己的开关。
  const status: AutomationStatus = automation?.enabledByUser ? "ACTIVE" : "PAUSED";
  const stateLabel = status === "ACTIVE"
    ? text("运行中", "Running")
    : text("已暂停", "Paused");
  const disabled = pending || Boolean(unavailableReason);
  const selectedModel = models.find((model) => model.slug === draft.model) ?? null;
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft({ ...DEFAULT_OPTIONS, ...automation });
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动认领待办设置", "Auto-claim settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自动认领待办", "Auto-claim tasks")}</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>{text("自动认领开关", "Auto-claim")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <label className="project-automation-field">
        <span>{text("间隔", "Interval")}</span>
        <select
          value={draft.intervalMinutes}
          disabled={disabled}
          onChange={(event) => submitChange({
            ...draft,
            intervalMinutes: Number(event.target.value),
          })}
        >
          {[5, 10, 15, 30, 60].map((minutes) => (
            <option key={minutes} value={minutes}>{text(`${minutes} 分钟`, `${minutes} min`)}</option>
          ))}
        </select>
      </label>
      <label className="project-automation-field">
        <span>{text("模型", "Model")}</span>
        <select
          value={draft.model ?? ""}
          disabled={disabled}
          onChange={(event) => submitChange({ ...draft, model: event.target.value || null, reasoningEffort: null })}
        >
          <option value="">{text("跟随后端默认", "Backend default")}</option>
          {models.map((model) => (
            <option key={model.slug} value={model.slug}>{model.displayName}</option>
          ))}
        </select>
      </label>
      <label className="project-automation-field">
        <span>{text("推理强度", "Reasoning effort")}</span>
        <select
          value={draft.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? ""}
          disabled={disabled}
          onChange={(event) => submitChange({ ...draft, reasoningEffort: event.target.value || null })}
        >
          <option value="">{text("跟随模型默认", "Model default")}</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>{text(...(EFFORT_LABELS[effort] ?? [effort, effort]))}</option>
          ))}
        </select>
      </label>
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />
        <span>{status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}</span>
      </button>
      {menu}
    </>
  );
}

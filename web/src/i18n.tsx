import { createContext, useContext, type ReactNode } from "react";
import type { TaskPriority, TaskStatus } from "./types";

export type TaskboardLanguage = "zh" | "en";

interface TaskboardI18n {
  language: TaskboardLanguage;
  locale: "zh-CN" | "en";
  text: (chinese: string, english: string) => string;
}

const I18N: Record<TaskboardLanguage, TaskboardI18n> = {
  zh: {
    language: "zh",
    locale: "zh-CN",
    text: (chinese) => chinese,
  },
  en: {
    language: "en",
    locale: "en",
    text: (_chinese, english) => english,
  },
};

const STATUS_LABELS: Record<TaskboardLanguage, Record<TaskStatus, string>> = {
  zh: {
    backlog: "待立项",
    todo: "等待认领",
    in_progress: "处理中",
    in_review: "等你确认",
    // 底层枚举仍叫 blocked（扩 CHECK 约束要重建表），
    // 语义已收窄为「agent 提了问题，在等你回答」，泳道位于「处理中」与「等你确认」之间
    blocked: "等你回答",
    done: "完成",
    canceled: "取消",
  },
  en: {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
  },
};

const PRIORITY_LABELS: Record<TaskboardLanguage, Record<TaskPriority, string>> = {
  zh: {
    none: "无优先级",
    urgent: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  },
  en: {
    none: "No priority",
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
};

const TaskboardLanguageContext = createContext<TaskboardLanguage>("en");

export function resolveTaskboardLanguage(value: string | null | undefined): TaskboardLanguage {
  const normalized = value?.trim().replaceAll("_", "-").toLowerCase() ?? "";
  return normalized === "zh" || normalized.startsWith("zh-") ? "zh" : "en";
}

export function getTaskboardI18n(language: TaskboardLanguage): TaskboardI18n {
  return I18N[language];
}

export function taskStatusLabel(language: TaskboardLanguage, status: TaskStatus): string {
  return STATUS_LABELS[language][status];
}

export function taskPriorityLabel(language: TaskboardLanguage, priority: TaskPriority): string {
  return PRIORITY_LABELS[language][priority];
}

export function TaskboardLanguageProvider({
  language,
  children,
}: {
  language: TaskboardLanguage;
  children: ReactNode;
}) {
  return (
    <TaskboardLanguageContext.Provider value={language}>
      {children}
    </TaskboardLanguageContext.Provider>
  );
}

export function useTaskboardI18n(): TaskboardI18n {
  return I18N[useContext(TaskboardLanguageContext)];
}

import { describe, it, expect } from "vitest";
import {
  buildDraft,
  defaultSchedule,
  describeSchedule,
  describeValidity,
  inferPeriodicMode,
  scheduleModeOf,
  sortWeekdays,
  startsInLabel,
  validateDraft,
} from "../automation/schedule-utils";
import { AUTOMATION_TEMPLATES, createAutomationTemplates } from "../automation/template-config";
import type { AutomationSchedule } from "@/lib/types";

function schedule(patch: Partial<AutomationSchedule>): AutomationSchedule {
  return { ...defaultSchedule(), ...patch };
}

describe("schedule-utils", () => {
  it("sortWeekdays 按周一到周日排序并去重", () => {
    expect(sortWeekdays(["SU", "MO", "WE", "MO"])).toEqual(["MO", "WE", "SU"]);
  });

  it("scheduleModeOf: HOURLY → interval, once → once, 其余 → periodic", () => {
    expect(scheduleModeOf({ scheduleType: "once", schedule: defaultSchedule() })).toBe("once");
    expect(scheduleModeOf({ scheduleType: "recurring", schedule: schedule({ freq: "HOURLY" }) })).toBe("interval");
    expect(scheduleModeOf({ scheduleType: "recurring", schedule: defaultSchedule() })).toBe("periodic");
  });

  it("inferPeriodicMode: WEEKLY interval=2 → biweek", () => {
    expect(inferPeriodicMode(schedule({ freq: "WEEKLY", interval: 2 }))).toBe("biweek");
    expect(inferPeriodicMode(schedule({ freq: "WEEKLY", interval: 1 }))).toBe("week");
    expect(inferPeriodicMode(schedule({ freq: "MONTHLY" }))).toBe("month");
    expect(inferPeriodicMode(schedule({ freq: "YEARLY" }))).toBe("year");
    expect(inferPeriodicMode(schedule({ freq: "DAILY" }))).toBe("day");
  });

  it("describeSchedule 各频率文案", () => {
    expect(describeSchedule({ scheduleType: "recurring", schedule: schedule({ byhour: 9, byminute: 30 }) }))
      .toBe("每天 09:30");
    expect(
      describeSchedule({
        scheduleType: "recurring",
        schedule: schedule({ freq: "WEEKLY", byday: ["MO", "TU", "WE", "TH", "FR"], byhour: 18, byminute: 0 }),
      }),
    ).toBe("每个工作日 18:00");
    expect(
      describeSchedule({
        scheduleType: "recurring",
        schedule: schedule({ freq: "WEEKLY", byday: ["FR"], byhour: 17, byminute: 0 }),
      }),
    ).toBe("每周 周五 · 17:00");
    expect(
      describeSchedule({
        scheduleType: "recurring",
        schedule: schedule({ freq: "WEEKLY", interval: 2, byday: ["MO"], byhour: 9, byminute: 0 }),
      }),
    ).toBe("双周 周一 · 09:00");
    expect(
      describeSchedule({
        scheduleType: "recurring",
        schedule: schedule({ freq: "MONTHLY", bymonthday: [1, 15], byhour: 8, byminute: 0 }),
      }),
    ).toBe("每月 1/15 日 · 08:00");
    expect(
      describeSchedule({
        scheduleType: "recurring",
        schedule: schedule({ freq: "YEARLY", bymonth: [6], bymonthday: [1], byhour: 10, byminute: 0 }),
      }),
    ).toBe("每年 6月1日 · 10:00");
    expect(
      describeSchedule({ scheduleType: "recurring", schedule: schedule({ freq: "HOURLY", intervalHours: 2 }) }),
    ).toBe("每 2 小时（每天从 09:00 起）");
    expect(
      describeSchedule({ scheduleType: "once", schedule: defaultSchedule(), scheduledDate: "2026-04-08", scheduledTime: "07:00" }),
    ).toBe("单次 · 04/08 07:00");
  });

  it("describeValidity 生效区间文案", () => {
    expect(describeValidity({ validFromDate: "2026-03-18", validUntilDate: "2026-06-30" }))
      .toBe("生效期 2026-03-18 - 2026-06-30");
    expect(describeValidity({ validFromDate: "2026-03-18", validUntilDate: "" })).toBe("自 2026-03-18 生效");
    expect(describeValidity({ validFromDate: "", validUntilDate: "2026-06-30" })).toBe("至 2026-06-30 截止");
    expect(describeValidity({ validFromDate: "", validUntilDate: "" })).toBeNull();
  });

  it("validateDraft: 名称/提示词必填", () => {
    const draft = buildDraft();
    draft.name = "  ";
    expect(validateDraft(draft, { isCreating: true })).toBe("请填写自动化任务名称");
    draft.name = "任务";
    draft.prompt = " ";
    expect(validateDraft(draft, { isCreating: true })).toBe("请填写提示词");
    draft.prompt = "做点事";
    expect(validateDraft(draft, { isCreating: true })).toBeNull();
  });

  it("validateDraft: 每周至少选一天 / 每月至少选一天 / 每年选月选日", () => {
    const draft = buildDraft();
    draft.prompt = "p";
    draft.name = "n";
    draft.schedule = schedule({ freq: "WEEKLY", byday: [] });
    expect(validateDraft(draft, { isCreating: true })).toBe("请至少选择一个星期");
    draft.schedule = schedule({ freq: "MONTHLY", bymonthday: [] });
    expect(validateDraft(draft, { isCreating: true })).toBe("请至少选择一个日期");
    draft.schedule = schedule({ freq: "YEARLY", bymonth: [], bymonthday: [1] });
    expect(validateDraft(draft, { isCreating: true })).toBe("请选择月份");
    draft.schedule = schedule({ freq: "YEARLY", bymonth: [6], bymonthday: [] });
    expect(validateDraft(draft, { isCreating: true })).toBe("请选择日期");
  });

  it("validateDraft: 按间隔执行限制为 1 至 24 小时", () => {
    const draft = buildDraft();
    draft.name = "按间隔";
    draft.prompt = "run";
    draft.schedule = schedule({ freq: "HOURLY", intervalHours: 25 });
    expect(validateDraft(draft, { isCreating: true })).toBe("按间隔执行需设置为 1 至 24 小时");
  });

  it("validateDraft: 单次必须选择日期且晚于当前时间", () => {
    const draft = buildDraft();
    draft.prompt = "p";
    draft.name = "n";
    draft.scheduleType = "once";
    draft.scheduledDate = "";
    expect(validateDraft(draft, { isCreating: true })).toBe("请选择单次执行日期");
    draft.scheduledDate = "2000-01-01";
    draft.scheduledTime = "00:00";
    expect(validateDraft(draft, { isCreating: true })).toBe("单次执行时间必须晚于当前时间");
    const future = new Date(Date.now() + 3600_000);
    draft.scheduledDate = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    draft.scheduledTime = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
    expect(validateDraft(draft, { isCreating: true })).toBeNull();
  });

  it("startsInLabel: 未来时间生成「x后执行」", () => {
    expect(startsInLabel(new Date(Date.now() + 30_000).toISOString())).toBe("即将执行");
    expect(startsInLabel(new Date(Date.now() + 5 * 60_000).toISOString())).toBe("5分钟后执行");
    expect(startsInLabel(new Date(Date.now() + 3 * 3600_000).toISOString())).toBe("3小时后执行");
    expect(startsInLabel(new Date(Date.now() + 2 * 86400_000).toISOString())).toBe("2天后执行");
    expect(startsInLabel(undefined)).toBeNull();
    expect(startsInLabel(new Date(Date.now() - 1000).toISOString())).toBeNull();
  });

  it("模板：12 个且字段齐备", () => {
    expect(AUTOMATION_TEMPLATES).toHaveLength(12);
    for (const tpl of AUTOMATION_TEMPLATES) {
      expect(tpl.title).toBeTruthy();
      expect(tpl.content).toBeTruthy();
      expect(tpl.prompt).toBeTruthy();
      expect(tpl.schedule.byhour).toBeGreaterThanOrEqual(0);
      expect(tpl.Icon).toBeTruthy();
    }
    expect(AUTOMATION_TEMPLATES.map((t) => t.title)).toContain("每日 AI 新闻推送");
    expect(AUTOMATION_TEMPLATES.map((t) => t.title)).toContain("可爱萌宠手机壁纸");
  });

  it("提醒模板按当前日期生成，不会随版本过期", () => {
    const templates = createAutomationTemplates(new Date(2030, 0, 15, 12, 0));
    const health = templates.find((item) => item.id === "health-checkup-appointment-reminder")!;
    const meeting = templates.find((item) => item.id === "pre-meeting-preparation")!;
    const interview = templates.find((item) => item.id === "interview-preparation-reminder")!;
    const parent = templates.find((item) => item.id === "parent-contact-reminder")!;
    expect(health.scheduledDate).toBe("2030-01-22");
    expect(meeting.scheduledDate).toBe("2030-01-16");
    expect(interview.validFromDate).toBe("2030-01-15");
    expect(interview.validUntilDate).toBe("2030-02-14");
    expect(parent.validUntilDate).toBeUndefined();
  });

  it("validateDraft: 拒绝倒置或已过期的生效区间", () => {
    const draft = buildDraft();
    draft.name = "任务";
    draft.prompt = "执行";
    draft.validFromDate = "2030-02-01";
    draft.validUntilDate = "2030-01-01";
    expect(validateDraft(draft, { isCreating: true })).toBe("生效开始日期不能晚于结束日期");
    draft.validFromDate = "";
    draft.validUntilDate = "2000-01-01";
    expect(validateDraft(draft, { isCreating: true })).toBe("生效日期区间已过期，请更新结束日期");
  });

  it("buildDraft(template) 预填名称/提示词/调度", () => {
    const tpl = AUTOMATION_TEMPLATES.find((t) => t.id === "daily-ai-news")!;
    const draft = buildDraft(tpl);
    expect(draft.name).toBe("每日 AI 新闻推送");
    expect(draft.prompt).toContain("AI coding");
    expect(draft.schedule.byhour).toBe(9);
    expect(draft.permissionMode).toBe("default");
    expect(draft.scheduleType).toBe("recurring");
    expect(draft.pushToWeChat).toBe(true);
  });
});

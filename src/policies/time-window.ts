import { type PostParamsNormalizationParams, TOOL_TYPE } from "@hashgraph/hedera-agent-kit";
import { assertTimeZone, parseClock, weekdayName, zonedTime } from "../time";
import { SpendPolicy, type SpendPolicyOptions } from "./base";

export interface TimeWindow {
  /** Days the window opens on, 0 = Sunday … 6 = Saturday. Default: every day. */
  days?: number[];
  /** Local opening time, `HH:MM`. */
  start: string;
  /** Local closing time, `HH:MM`. Earlier than `start` means the window runs past midnight. */
  end: string;
}

export interface TimeWindowOptions extends SpendPolicyOptions {
  /** IANA zone the windows are written in, e.g. `America/Bogota`. */
  timeZone: string;
  windows: TimeWindow[];
  /** Tools to restrict. Default: every transaction tool, plus any tool with a spend extractor. */
  tools?: string[];
  now?: () => Date;
}

interface ParsedWindow {
  days: Set<number>;
  start: number;
  end: number;
  label: string;
}

/**
 * Only lets the agent transact during set hours, e.g. weekdays 08:00 to 20:00 Bogotá time.
 * Queries are never restricted, so the agent can still read balances at 3 a.m.
 */
export class TimeWindowPolicy extends SpendPolicy {
  name = "Time Window";
  description: string;
  private readonly timeZone: string;
  private readonly windows: ParsedWindow[];
  private readonly restrictByType: boolean;
  private readonly now: () => Date;

  constructor(options: TimeWindowOptions) {
    super(options);
    assertTimeZone(options.timeZone, "TimeWindowPolicy");
    if (options.windows.length === 0) throw new Error("TimeWindowPolicy: give at least one window");
    this.timeZone = options.timeZone;
    this.windows = options.windows.map((window, index) => {
      const days = window.days ?? [0, 1, 2, 3, 4, 5, 6];
      if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error(`TimeWindowPolicy: window ${index} days must be integers 0 to 6`);
      }
      const start = parseClock(window.start, `TimeWindowPolicy window ${index} start`);
      const end = parseClock(window.end, `TimeWindowPolicy window ${index} end`);
      if (start === end) throw new Error(`TimeWindowPolicy: window ${index} is empty`);
      const dayList = window.days ? days.map(weekdayName).join("/") : "daily";
      return { days: new Set(days), start, end, label: `${dayList} ${window.start}-${window.end}` };
    });
    this.restrictByType = !options.tools;
    this.relevantTools = options.tools ?? ["*"];
    this.now = options.now ?? (() => new Date());
    this.description = `Transacts only ${this.windows.map((w) => w.label).join(", ")} ${this.timeZone}`;
  }

  /** Whether a transaction would be allowed at `date` (default: now). */
  isOpen(date: Date = this.now()): boolean {
    const { weekday, minutes } = zonedTime(date, this.timeZone);
    const yesterday = (weekday + 6) % 7;
    return this.windows.some((window) =>
      window.start < window.end
        ? window.days.has(weekday) && minutes >= window.start && minutes < window.end
        : (window.days.has(weekday) && minutes >= window.start) ||
          (window.days.has(yesterday) && minutes < window.end),
    );
  }

  protected override async shouldBlockPostParamsNormalization(
    params: PostParamsNormalizationParams,
    method: string,
  ): Promise<boolean> {
    const hasExtractor = method in this.extractors;
    if (this.restrictByType && params.toolType !== TOOL_TYPE.TRANSACTION && !hasExtractor) {
      return false;
    }
    const now = this.now();
    if (this.isOpen(now)) return false;
    const { clock } = zonedTime(now, this.timeZone);
    return this.refuse(
      `it is ${clock} in ${this.timeZone}, outside the hours this agent may transact ` +
        `(${this.windows.map((w) => w.label).join(", ")})`,
      hasExtractor ? this.intentOf(params, method) : null,
      params.client,
    );
  }
}

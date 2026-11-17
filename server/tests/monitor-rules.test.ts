import { describe, expect, it } from 'vitest';
import { extendedMinutes, isStalled, MAX_TOTAL_EXTENSION_MINUTES, monitorStatus, remainingSeconds, rowRank } from '../src/modules/monitor/monitor.rules';

const t0 = new Date('2026-11-20T10:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);

describe('monitorStatus', () => {
  it('a running attempt wins, then the latest finished one, then not started', () => {
    expect(monitorStatus([])).toBe('not_started');
    expect(monitorStatus([{ status: 'invalidated', attemptNo: 1 }])).toBe('not_started');
    expect(monitorStatus([{ status: 'in_progress', attemptNo: 1 }])).toBe('in_progress');
    expect(monitorStatus([{ status: 'submitted', attemptNo: 1 }, { status: 'in_progress', attemptNo: 2 }])).toBe('in_progress');
    expect(monitorStatus([{ status: 'submitted', attemptNo: 1 }, { status: 'auto_submitted', attemptNo: 2 }])).toBe('auto_submitted');
    expect(monitorStatus([{ status: 'auto_submitted', attemptNo: 1 }, { status: 'submitted', attemptNo: 2 }])).toBe('submitted');
  });
});

describe('isStalled', () => {
  const attempt = { status: 'in_progress' as const, endsAt: at(1800), lastActivityAt: at(0) };
  it('is true only past the threshold, while time remains', () => {
    expect(isStalled(attempt, at(90), 90_000)).toBe(false); // exactly at the threshold: not yet
    expect(isStalled(attempt, at(91), 90_000)).toBe(true);
    expect(isStalled({ ...attempt, lastActivityAt: at(100) }, at(150), 90_000)).toBe(false); // saved recently
  });
  it('is false once the deadline has passed, and for attempts that are not running', () => {
    expect(isStalled(attempt, at(1801), 90_000)).toBe(false); // out of time is not "stalled"
    expect(isStalled({ ...attempt, status: 'submitted' as never }, at(500), 90_000)).toBe(false);
  });
});

describe('remainingSeconds, extensions, ordering', () => {
  it('never goes negative and floors partial seconds', () => {
    expect(remainingSeconds(at(100), at(40))).toBe(60);
    expect(remainingSeconds(new Date(t0.getTime() + 100_900), t0)).toBe(100);
    expect(remainingSeconds(at(10), at(500))).toBe(0);
  });
  it('sums extension minutes', () => {
    expect(extendedMinutes(undefined)).toBe(0);
    expect(extendedMinutes([{ minutes: 10 }, { minutes: 5 }])).toBe(15);
    expect(MAX_TOTAL_EXTENSION_MINUTES).toBe(240);
  });
  it('puts problems first: stalled, running, not started, auto-submitted, submitted', () => {
    const order = [rowRank('in_progress', true), rowRank('in_progress', false), rowRank('not_started', false), rowRank('auto_submitted', false), rowRank('submitted', false)];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(5);
  });
});

/**
 * The deterministic answer pattern of the load test (ANSWER_PATTERN_VERSION 1). The k6 script (load/k6/exam.js) and the verifier
 * (verify-load-run.ts) must implement EXACTLY this, so the verifier can recompute, from an attempt's lastSeq alone, which answers the
 * server must hold. If they differ, the verifier reports false losses: keep the three in step.
 *
 * Autosave number `seq` (1, 2, 3...) changes question (seq - 1) % questionCount to option (userIndex + questionIndex + seq) % 2.
 * Requests are cumulative, so after the server accepted seq = L, every change 1..L is stored (the latest per question wins).
 */
export const ANSWER_PATTERN_VERSION = 1;
export const OPTIONS_USED = 2;

export const questionIndexOf = (seq: number, questionCount: number): number => (seq - 1) % questionCount;
export const optionIndex = (userIndex: number, questionIndex: number, seq: number): number => (userIndex + questionIndex + seq) % OPTIONS_USED;

/** For each question, the option index the server must hold after accepting autosave `lastSeq` (null = never answered). */
export function expectedAnswers(userIndex: number, questionCount: number, lastSeq: number): Array<number | null> {
  const out: Array<number | null> = Array.from({ length: questionCount }, () => null);
  for (let seq = 1; seq <= lastSeq; seq++) {
    const qi = questionIndexOf(seq, questionCount);
    out[qi] = optionIndex(userIndex, qi, seq);
  }
  return out;
}

/** "load.17" -> 17. Anything else is not a load-test student. */
export function userIndexOf(loginId: string): number | null {
  const m = /^load\.(\d+)$/.exec(loginId);
  return m ? Number(m[1]) : null;
}

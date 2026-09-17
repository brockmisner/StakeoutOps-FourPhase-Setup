/** Public DuoPlus RPA node identifiers that are safe to retain as labels. */
export const DUOPLUS_EVIDENCE_ACTIONS = [
  "START",
  "DESKTOP",
  "OPEN_APP",
  "PAGE_BACK",
  "KEYBOARD_OPERATION",
  "PAGE_SCREENSHOT",
  "SLIDE_PAGE",
  "UPLOAD_FILE",
  "EXECUTE_ADB",
  "CLICK_ELEMENT",
  "CLICK_COORDINATE",
  "LONG_ELEMENT",
  "LONG_COORDINATE",
  "INPUT_CONTENT",
  "WAIT_TIME",
  "WAIT_FOR_SELECTOR",
  /** Legacy alias observed in earlier DuoPlus payloads. */
  "WAIT_SELECTOR",
  "GET_SINGLE_ELEMENT_TEXT",
  "NET_REQUEST",
  "TEXT_EXTRACTION",
  "OUTPUT_LOG",
  "WRITE_TEXT",
  "INSTALL_APP",
  "IF_CONDITION",
  "FOR_DATA",
  "FOR_TIMES",
  "BREAK_LOOP",
  "END_TASK",
  "GET_EMAIL",
  "OUTLOOK_EMAIL",
] as const;

export type DuoPlusEvidenceAction = (typeof DUOPLUS_EVIDENCE_ACTIONS)[number];

const evidenceActionSet: ReadonlySet<string> = new Set(DUOPLUS_EVIDENCE_ACTIONS);

export function isDuoPlusEvidenceAction(value: unknown): value is DuoPlusEvidenceAction {
  return typeof value === "string" && evidenceActionSet.has(value);
}

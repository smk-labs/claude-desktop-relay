import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";

import type { Verdict } from "./verdict.ts";

/** The last verdict, kept so who paid is answerable without running a session. */
export type VerdictLog = {
  record(verdict: Verdict): Promise<void>;
  /** The last verdict recorded, or null when none has been. */
  last(): Promise<Verdict | null>;
};

export function openVerdictLog(options: { file: string }): VerdictLog {
  return {
    record: (verdict) => writeJsonFile(options.file, verdict),
    last: () => readJsonFile<Verdict>(options.file),
  };
}

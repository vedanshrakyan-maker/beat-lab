import { parseXUrl } from "@/platforms/urls";
import { PlatformNotSupportedError, type PlatformAdapter } from "@/platforms/types";

/** X (Twitter) stub. URL parsing works so we can reject X links with a clear message. */
export class XAdapter implements PlatformAdapter {
  readonly platform = "X" as const;
  readonly mode = "live" as const;
  readonly batchSize = 1;

  parsePostUrl(url: string) {
    return parseXUrl(url);
  }
  async verifyAccountOwnership(): Promise<never> {
    throw new PlatformNotSupportedError("X");
  }
  async fetchPostMetrics(): Promise<never> {
    throw new PlatformNotSupportedError("X");
  }
  async fetchPostExists(): Promise<never> {
    throw new PlatformNotSupportedError("X");
  }
  async fetchAccountProfile(): Promise<never> {
    throw new PlatformNotSupportedError("X");
  }
}

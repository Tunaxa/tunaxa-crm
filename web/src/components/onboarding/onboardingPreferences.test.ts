import { describe, expect, it } from "vitest";
import {
  onboardingPreferenceKey,
  readOnboardingPreference,
  workspaceIsEmpty,
  writeOnboardingPreference,
} from "./onboardingPreferences";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("onboarding preferences", () => {
  it("stores progress separately for each user", () => {
    const storage = memoryStorage();
    writeOnboardingPreference("user-1", "in-progress", 2, storage);

    expect(readOnboardingPreference("user-1", storage)).toMatchObject({
      status: "in-progress",
      currentStep: 2,
    });
    expect(readOnboardingPreference("user-2", storage)).toBeNull();
    expect(onboardingPreferenceKey("user-1")).not.toBe(
      onboardingPreferenceKey("user-2"),
    );
  });

  it("rejects invalid stored values and limits the step range", () => {
    const storage = memoryStorage();
    storage.setItem(onboardingPreferenceKey("user-1"), "not-json");
    expect(readOnboardingPreference("user-1", storage)).toBeNull();

    writeOnboardingPreference("user-1", "in-progress", 99, storage);
    expect(readOnboardingPreference("user-1", storage)?.currentStep).toBe(3);
  });
});

describe("empty workspace detection", () => {
  it("requires every core resource to be empty", () => {
    expect(workspaceIsEmpty([[], [], [], []])).toBe(true);
    expect(workspaceIsEmpty([[], [{ id: "contact-1" }], [], []])).toBe(false);
    expect(workspaceIsEmpty([[], null, [], []])).toBe(false);
  });
});

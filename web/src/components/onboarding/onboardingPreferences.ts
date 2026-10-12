export type OnboardingPreferenceStatus =
  | "in-progress"
  | "completed"
  | "skipped";

export type OnboardingPreference = {
  status: OnboardingPreferenceStatus;
  currentStep: number;
  updatedAt: string;
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export const onboardingPreferenceKey = (userId: string) =>
  `tunaxa.onboarding.preference:${userId}`;

export function readOnboardingPreference(
  userId: string,
  storage: PreferenceStorage = localStorage,
): OnboardingPreference | null {
  try {
    const value = JSON.parse(storage.getItem(onboardingPreferenceKey(userId)) || "null");
    if (
      !value ||
      !["in-progress", "completed", "skipped"].includes(value.status) ||
      !Number.isInteger(value.currentStep)
    )
      return null;
    return {
      status: value.status,
      currentStep: Math.min(3, Math.max(0, value.currentStep)),
      updatedAt: String(value.updatedAt || ""),
    };
  } catch {
    return null;
  }
}

export function writeOnboardingPreference(
  userId: string,
  status: OnboardingPreferenceStatus,
  currentStep: number,
  storage: PreferenceStorage = localStorage,
) {
  const preference: OnboardingPreference = {
    status,
    currentStep: Math.min(3, Math.max(0, currentStep)),
    updatedAt: new Date().toISOString(),
  };
  storage.setItem(onboardingPreferenceKey(userId), JSON.stringify(preference));
  return preference;
}

export function workspaceIsEmpty(resourceRows: unknown[]) {
  return resourceRows.every((rows) => Array.isArray(rows) && rows.length === 0);
}

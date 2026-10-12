import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../Icon";
import { api, json } from "../../lib/api";
import {
  readOnboardingPreference,
  workspaceIsEmpty,
  writeOnboardingPreference,
} from "./onboardingPreferences";

type OnboardingGateProps = {
  userId: string;
  children: ReactNode;
};

type OnboardingStatus = {
  completed?: boolean;
};

const steps = [
  {
    title: "Company profile",
    description: "Add your company identity and regional settings.",
    icon: "companies",
  },
  {
    title: "Import contacts",
    description: "Bring your existing contacts into the CRM.",
    icon: "contacts",
  },
  {
    title: "Set up pipeline",
    description: "Choose the stages your sales team uses.",
    icon: "pipeline",
  },
  {
    title: "Invite your team",
    description: "Invite a teammate to start collaborating.",
    icon: "team",
  },
] as const;

const defaultStages = [
  "New",
  "Qualified",
  "Proposal",
  "Negotiation",
  "Won",
  "Lost",
];

const commonTimezones = [
  "Africa/Tunis",
  "Europe/Paris",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "UTC",
];

export function OnboardingGate({ userId, children }: OnboardingGateProps) {
  const preference = readOnboardingPreference(userId);
  const [checking, setChecking] = useState(
    preference?.status !== "completed" && preference?.status !== "skipped",
  );
  const [showWizard, setShowWizard] = useState(false);
  const [initialStep, setInitialStep] = useState(preference?.currentStep ?? 0);

  useEffect(() => {
    if (preference?.status === "completed" || preference?.status === "skipped")
      return;

    let cancelled = false;
    Promise.all([
      api<OnboardingStatus>("/onboarding/status"),
      api<unknown[]>("/leads"),
      api<unknown[]>("/contacts"),
      api<unknown[]>("/companies"),
      api<unknown[]>("/deals"),
    ])
      .then(([status, ...resources]) => {
        if (cancelled) return;
        if (status.completed) {
          writeOnboardingPreference(userId, "completed", 3);
          setShowWizard(false);
          return;
        }

        if (preference?.status === "in-progress" || workspaceIsEmpty(resources)) {
          const step = preference?.currentStep ?? 0;
          writeOnboardingPreference(userId, "in-progress", step);
          setInitialStep(step);
          setShowWizard(true);
        } else {
          writeOnboardingPreference(userId, "completed", 3);
          setShowWizard(false);
        }
      })
      .catch(() => {
        if (!cancelled) setShowWizard(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (checking)
    return (
      <main className="onboarding-loading" aria-live="polite">
        <img src="/assets/tunaxa-logo.png" alt="Tunaxa" />
        <span>Preparing your workspace…</span>
      </main>
    );

  if (showWizard)
    return (
      <OnboardingWizard
        userId={userId}
        initialStep={initialStep}
        onComplete={() => setShowWizard(false)}
      />
    );

  return children;
}

function OnboardingWizard({
  userId,
  initialStep,
  onComplete,
}: {
  userId: string;
  initialStep: number;
  onComplete: () => void;
}) {
  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [step, setStep] = useState(initialStep);
  const [companyName, setCompanyName] = useState("");
  const [timezone, setTimezone] = useState(detectedTimezone || "UTC");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState("");
  const [contactFile, setContactFile] = useState<File | null>(null);
  const [stages, setStages] = useState(defaultStages);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Record<string, any>>("/settings")
      .then((settings) => {
        setCompanyName(String(settings.workspaceName || ""));
        setTimezone(String(settings.timezone || detectedTimezone || "UTC"));
        setLogoPreview(String(settings.workspaceLogo || ""));
        if (Array.isArray(settings.pipelineStages) && settings.pipelineStages.length)
          setStages(settings.pipelineStages.map(String));
      })
      .catch(() => {});
  }, []);

  useEffect(
    () => () => {
      if (logoPreview.startsWith("blob:")) URL.revokeObjectURL(logoPreview);
    },
    [logoPreview],
  );

  function pickLogo(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file for the company logo.");
      return;
    }
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
    setError("");
  }

  function moveTo(nextStep: number) {
    const safeStep = Math.min(3, Math.max(0, nextStep));
    writeOnboardingPreference(userId, "in-progress", safeStep);
    setStep(safeStep);
    setError("");
  }

  async function markStep(serverStep: string, data: Record<string, unknown> = {}) {
    await api("/onboarding/step", json("POST", { step: serverStep, data }));
  }

  async function saveCompany() {
    if (!companyName.trim()) {
      setError("Company name is required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let workspaceLogo = logoPreview.startsWith("blob:") ? "" : logoPreview;
      if (logoFile) {
        const upload = new FormData();
        upload.append("files", logoFile);
        const [saved] = await api<{ url: string }[]>("/uploads", {
          method: "POST",
          body: upload,
        });
        workspaceLogo = saved?.url || "";
      }
      await api(
        "/settings",
        json("PUT", {
          workspaceName: companyName.trim(),
          workspaceLogo,
          timezone,
        }),
      );
      await markStep("company", {
        name: companyName.trim(),
        logo: workspaceLogo,
        timezone,
      });
      moveTo(1);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importContacts() {
    if (!contactFile) {
      setError("Choose a CSV file or skip this step.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const upload = new FormData();
      upload.append("file", contactFile);
      await api("/import/contacts", { method: "POST", body: upload });
      moveTo(2);
    } catch (importError) {
      setError((importError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function updateStage(index: number, value: string) {
    setStages((current) =>
      current.map((stageName, stageIndex) =>
        stageIndex === index ? value : stageName,
      ),
    );
  }

  async function savePipeline() {
    const validStages = stages.map((value) => value.trim()).filter(Boolean);
    if (validStages.length < 2) {
      setError("Add at least two named pipeline stages.");
      return;
    }
    if (new Set(validStages.map((value) => value.toLowerCase())).size !== validStages.length) {
      setError("Pipeline stage names must be unique.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await markStep("pipeline", { stages: validStages });
      setStages(validStages);
      moveTo(3);
    } catch (pipelineError) {
      setError((pipelineError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finishOnboarding(email?: string) {
    setBusy(true);
    setError("");
    try {
      const normalizedEmail = email?.trim().toLowerCase() || "";
      if (normalizedEmail) {
        await api("/users/invite", json("POST", { email: normalizedEmail }));
      }
      await markStep("invite", {
        emails: normalizedEmail ? [normalizedEmail] : [],
      });
      await markStep("import");
      writeOnboardingPreference(userId, "completed", 3);
      onComplete();
    } catch (inviteError) {
      setError((inviteError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function skipCurrentStep() {
    setBusy(true);
    setError("");
    try {
      if (step === 0) await markStep("company");
      if (step === 2) await markStep("pipeline");
      if (step === 3) {
        await finishOnboarding();
        return;
      }
      moveTo(step + 1);
    } catch (skipError) {
      setError((skipError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function skipWizard() {
    setBusy(true);
    setError("");
    try {
      await api("/onboarding/skip", json("POST"));
      writeOnboardingPreference(userId, "skipped", step);
      onComplete();
    } catch (skipError) {
      setError((skipError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const timezoneOptions = Array.from(
    new Set([timezone, detectedTimezone, ...commonTimezones].filter(Boolean)),
  );

  return (
    <main className="onboarding-page">
      <section className="onboarding-shell" aria-labelledby="onboarding-title">
        <header className="onboarding-header">
          <img src="/assets/tunaxa-logo.png" alt="Tunaxa" />
          <button
            className="btn ghost compact"
            type="button"
            disabled={busy}
            onClick={skipWizard}
          >
            Skip setup
          </button>
        </header>

        <div className="onboarding-progress">
          <div className="onboarding-progress-copy">
            <span>
              Step {step + 1} of {steps.length}
            </span>
            <strong>{Math.round(((step + 1) / steps.length) * 100)}%</strong>
          </div>
          <div
            className="onboarding-progress-track"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={step + 1}
            aria-label="Onboarding progress"
          >
            <span style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
          </div>
        </div>

        <div className="onboarding-layout">
          <ol className="onboarding-steps" aria-label="Setup steps">
            {steps.map((item, index) => (
              <li
                key={item.title}
                className={
                  index === step ? "active" : index < step ? "complete" : ""
                }
                aria-current={index === step ? "step" : undefined}
              >
                <span>{index < step ? "✓" : index + 1}</span>
                <div>
                  <b>{item.title}</b>
                  <small>{item.description}</small>
                </div>
              </li>
            ))}
          </ol>

          <div className="onboarding-content">
            <div className="onboarding-title-row">
              <span className="onboarding-step-icon">
                <Icon name={steps[step].icon} />
              </span>
              <div>
                <h1 id="onboarding-title">{steps[step].title}</h1>
                <p>{steps[step].description}</p>
              </div>
            </div>

            {step === 0 ? (
              <div className="onboarding-form">
                <label className="field">
                  <span>Company name</span>
                  <input
                    autoFocus
                    value={companyName}
                    placeholder="Your company"
                    onChange={(event) => setCompanyName(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Company logo</span>
                  <span className="onboarding-logo-picker">
                    <span className="onboarding-logo-preview">
                      {logoPreview ? (
                        <img src={logoPreview} alt="Company logo preview" />
                      ) : (
                        <Icon name="companies" />
                      )}
                    </span>
                    <span className="btn secondary compact" aria-hidden="true">
                      Choose image
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      aria-label="Choose company logo"
                      onChange={(event) => pickLogo(event.target.files?.[0])}
                    />
                  </span>
                </label>
                <label className="field">
                  <span>Timezone</span>
                  <select
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                  >
                    {timezoneOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="onboarding-upload-step">
                <label className={`onboarding-dropzone ${contactFile ? "selected" : ""}`}>
                  <Icon name="upload" size={24} />
                  <strong>{contactFile ? contactFile.name : "Choose a contacts CSV"}</strong>
                  <span>
                    {contactFile
                      ? `${Math.max(1, Math.round(contactFile.size / 1024))} KB ready to import`
                      : "CSV files with a header row, up to 1,000 contacts"}
                  </span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    aria-label="Choose contacts CSV"
                    onChange={(event) => {
                      setContactFile(event.target.files?.[0] || null);
                      setError("");
                    }}
                  />
                </label>
                <div className="onboarding-import-help">
                  <b>Common columns</b>
                  <span>name, email, phone, company, owner</span>
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="onboarding-pipeline-step">
                <div className="onboarding-stage-list">
                  {stages.map((stageName, index) => (
                    <div className="onboarding-stage-row" key={index}>
                      <span>{index + 1}</span>
                      <label className="field">
                        <span className="sr-only">Stage {index + 1}</span>
                        <input
                          value={stageName}
                          onChange={(event) => updateStage(index, event.target.value)}
                        />
                      </label>
                      <button
                        className="icon-btn tiny danger-link"
                        type="button"
                        disabled={stages.length <= 2}
                        aria-label={`Remove ${stageName || `stage ${index + 1}`}`}
                        onClick={() =>
                          setStages((current) =>
                            current.filter((_, stageIndex) => stageIndex !== index),
                          )
                        }
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  className="btn secondary compact"
                  type="button"
                  onClick={() => setStages((current) => [...current, "New stage"])}
                >
                  <Icon name="plus" /> Add stage
                </button>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="onboarding-invite-step">
                <div className="onboarding-invite-illustration">
                  <Icon name="team" size={30} />
                </div>
                <label className="field">
                  <span>Team member email</span>
                  <input
                    autoFocus
                    type="email"
                    value={inviteEmail}
                    placeholder="teammate@company.com"
                    onChange={(event) => {
                      setInviteEmail(event.target.value);
                      setError("");
                    }}
                  />
                </label>
                <p>
                  They’ll receive an invitation to join this Tunaxa workspace.
                </p>
              </div>
            ) : null}

            {error ? (
              <p className="onboarding-error" role="alert">
                {error}
              </p>
            ) : null}

            <footer className="onboarding-actions">
              <button
                className="btn ghost"
                type="button"
                disabled={busy}
                onClick={skipCurrentStep}
              >
                Skip this step
              </button>
              <div>
                {step > 0 ? (
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => moveTo(step - 1)}
                  >
                    Back
                  </button>
                ) : null}
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={
                    step === 0
                      ? saveCompany
                      : step === 1
                        ? importContacts
                        : step === 2
                          ? savePipeline
                          : () => {
                              if (!/^\S+@\S+\.\S+$/.test(inviteEmail.trim())) {
                                setError("Enter a valid email or skip this step.");
                                return;
                              }
                              void finishOnboarding(inviteEmail);
                            }
                  }
                >
                  {busy
                    ? "Saving…"
                    : step === 1
                      ? "Import and continue"
                      : step === 3
                        ? "Invite and finish"
                        : "Save and continue"}
                </button>
              </div>
            </footer>
          </div>
        </div>
      </section>
    </main>
  );
}

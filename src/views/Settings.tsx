import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button, Card, Field, Input, Pill, Select, Spinner } from "../components/ui";
import { setLang } from "../i18n";
import { store } from "../lib/pods";
import { useTasks } from "../lib/tasks";

interface BalanceInfo {
  ok: boolean;
  balance: number | null;
  currency: string | null;
  info: string | null;
  error: string | null;
}

interface KeyStatus {
  local_exists: boolean;
  in_runpod: boolean;
  public_key: string | null;
  private_key_path: string;
}

export default function Settings() {
  const { t, i18n } = useTranslation();
  const tasks = useTasks();

  const [runpodKey, setRunpodKey] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [keyBusy, setKeyBusy] = useState<"setup" | "reset" | null>(null);

  const savedRunpodKey = useRef("");

  useEffect(() => {
    (async () => {
      const r = (await store.get<string>("runpod_key")) ?? "";
      const h = (await store.get<string>("hf_token")) ?? "";
      const g = (await store.get<string>("gemini_key")) ?? "";
      setRunpodKey(r);
      setHfToken(h);
      setGeminiKey(g);
      savedRunpodKey.current = r;
      if (r) {
        refreshBalance(r);
        refreshKeyStatus(r);
      }
    })();
  }, []);

  async function refreshBalance(key: string) {
    setBalanceLoading(true);
    try {
      const b = await invoke<BalanceInfo>("runpod_balance", { apiKey: key });
      setBalance(b);
    } finally {
      setBalanceLoading(false);
    }
  }

  async function refreshKeyStatus(key: string) {
    try {
      const s = await invoke<KeyStatus>("get_ssh_key_status", { apiKey: key });
      setKeyStatus(s);
    } catch {
      setKeyStatus(null);
    }
  }

  async function changeLang(l: string) {
    setLang(l as "en" | "ru");
    await store.set("lang", l);
    await store.save();
  }

  async function save() {
    await store.set("runpod_key", runpodKey);
    await store.set("hf_token", hfToken);
    await store.set("gemini_key", geminiKey);
    await store.save();
    savedRunpodKey.current = runpodKey;
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
    await tasks.reloadSecrets();
    await tasks.reloadPods();
    if (runpodKey) {
      refreshBalance(runpodKey);
      refreshKeyStatus(runpodKey);
    }
  }

  async function setupSshKey() {
    if (!savedRunpodKey.current) return;
    setKeyBusy("setup");
    try {
      await invoke("setup_runpod_ssh_key", { apiKey: savedRunpodKey.current });
      await refreshKeyStatus(savedRunpodKey.current);
    } finally {
      setKeyBusy(null);
    }
  }

  async function resetSshKey() {
    if (!savedRunpodKey.current) return;
    setKeyBusy("reset");
    try {
      await invoke("revoke_runpod_ssh_key", { apiKey: savedRunpodKey.current });
      await refreshKeyStatus(savedRunpodKey.current);
    } finally {
      setKeyBusy(null);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <Card title={t("settings.title")}>
        <div className="space-y-5">
          <Field label={t("settings.language")}>
            <Select value={i18n.language} onChange={(e) => changeLang(e.target.value)}>
              <option value="en">English</option>
              <option value="ru">Русский</option>
            </Select>
          </Field>

          <Field label={t("settings.runpod")}>
            <Input
              type="password"
              value={runpodKey}
              onChange={(e) => setRunpodKey(e.target.value)}
              placeholder="rpa_..."
              autoComplete="off"
              spellCheck={false}
            />
            <BalanceLine loading={balanceLoading} balance={balance} t={t} />
          </Field>

          <Field
            label={t("settings.hf")}
            hint={t("settings.hf_hint")}
          >
            <Input
              type="password"
              value={hfToken}
              onChange={(e) => setHfToken(e.target.value)}
              placeholder="hf_..."
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field label={t("settings.gemini")} hint={t("settings.gemini_hint")}>
            <Input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="AIza..."
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {savedFlash && (
            <span className="text-xs text-green-600 dark:text-green-400">
              {t("common.saved")}
            </span>
          )}
          <Button onClick={save}>{t("settings.save")}</Button>
        </div>
      </Card>

      <Card title={t("settings.notifications")}>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={tasks.notificationsEnabled}
            onChange={(e) => tasks.setNotificationsEnabled(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-blue-500"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm">{t("settings.notifications")}</div>
            <div className="text-[11px] text-neutral-500 mt-0.5">
              {t("settings.notifications_hint")}
            </div>
          </div>
        </label>
      </Card>

      <Card title={t("settings.ssh")}>
        {!savedRunpodKey.current ? (
          <p className="text-sm text-neutral-500">{t("settings.no_runpod")}</p>
        ) : keyStatus === null ? (
          <p className="text-sm text-neutral-500 flex items-center gap-2">
            <Spinner /> {t("common.loading")}
          </p>
        ) : (
          <div className="flex items-center gap-3">
            {keyStatus.local_exists && keyStatus.in_runpod ? (
              <Pill tone="ok">✓ {t("settings.ssh_active")}</Pill>
            ) : (
              <Pill tone="neutral">{t("settings.ssh_inactive")}</Pill>
            )}
            <p className="flex-1 text-xs text-neutral-500">{t("settings.ssh_hint")}</p>
            {keyStatus.local_exists && keyStatus.in_runpod ? (
              <Button variant="ghost" size="sm" onClick={resetSshKey} disabled={!!keyBusy}>
                {keyBusy === "reset" ? t("settings.ssh_resetting") : t("settings.ssh_reset")}
              </Button>
            ) : (
              <Button size="sm" onClick={setupSshKey} disabled={!!keyBusy}>
                {keyBusy === "setup" ? t("settings.ssh_setting_up") : t("settings.ssh_setup")}
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function BalanceLine({
  loading,
  balance,
  t,
}: {
  loading: boolean;
  balance: BalanceInfo | null;
  t: (k: string) => string;
}) {
  if (loading) {
    return <span className="text-[11px] text-neutral-500">{t("settings.checking")}</span>;
  }
  if (!balance) return null;
  if (balance.ok) {
    return (
      <span className="text-[11px] text-green-600 dark:text-green-400 font-mono">
        {balance.balance != null
          ? `$${balance.balance.toFixed(2)} ${balance.currency ?? ""}`
          : t("settings.valid")}
      </span>
    );
  }
  return (
    <span className="text-[11px] text-red-500">{`${t("settings.invalid")}: ${balance.error ?? ""}`}</span>
  );
}

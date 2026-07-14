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

interface TelegramBotInfo {
  username: string | null;
  first_name: string | null;
}

interface TelegramChat {
  chat_id: number;
  label: string;
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

  // ---- telegram
  const [tgToken, setTgToken] = useState("");
  const [tgBotInfo, setTgBotInfo] = useState<TelegramBotInfo | null>(null);
  const [tgTokenError, setTgTokenError] = useState<string | null>(null);
  const [tgChatId, setTgChatId] = useState("");
  const [tgChatLabel, setTgChatLabel] = useState("");
  const [tgListening, setTgListening] = useState(false);
  const [tgListenError, setTgListenError] = useState<string | null>(null);
  const [tgEventsEnabled, setTgEventsEnabled] = useState(false);
  const [tgFilesEnabled, setTgFilesEnabled] = useState(false);

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

      const tt = (await store.get<string>("tg_bot_token")) ?? "";
      const tu = (await store.get<string>("tg_bot_username")) ?? "";
      const tcid = (await store.get<string>("tg_chat_id")) ?? "";
      const tcl = (await store.get<string>("tg_chat_label")) ?? "";
      const tev = (await store.get<boolean>("tg_events_enabled")) ?? false;
      const tfl = (await store.get<boolean>("tg_files_enabled")) ?? false;
      setTgToken(tt);
      if (tt && tu) setTgBotInfo({ username: tu, first_name: null });
      setTgChatId(tcid);
      setTgChatLabel(tcl);
      setTgEventsEnabled(tev);
      setTgFilesEnabled(tfl);
    })();
  }, []);

  async function validateTelegramToken() {
    setTgTokenError(null);
    try {
      const info = await invoke<TelegramBotInfo>("telegram_validate_bot_token", {
        token: tgToken,
      });
      setTgBotInfo(info);
      await store.set("tg_bot_token", tgToken);
      await store.set("tg_bot_username", info.username ?? "");
      await store.save();
    } catch (e) {
      setTgBotInfo(null);
      setTgTokenError(String(e));
    }
  }

  async function pickTelegramChat() {
    setTgListenError(null);
    setTgListening(true);
    try {
      const chat = await invoke<TelegramChat>("telegram_start_chat_listen", {
        token: tgToken,
      });
      setTgChatId(String(chat.chat_id));
      setTgChatLabel(chat.label);
      await store.set("tg_chat_id", String(chat.chat_id));
      await store.set("tg_chat_label", chat.label);
      await store.save();
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("cancelled")) setTgListenError(msg);
    } finally {
      setTgListening(false);
    }
  }

  async function setTelegramEventsEnabled(v: boolean) {
    setTgEventsEnabled(v);
    await store.set("tg_events_enabled", v);
    await store.save();
  }

  async function setTelegramFilesEnabled(v: boolean) {
    setTgFilesEnabled(v);
    await store.set("tg_files_enabled", v);
    await store.save();
  }

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
        <div className="space-y-5">
          <div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
              {t("settings.notifications_os")}
            </div>
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
          </div>

          <div className="border-t border-black/[0.06] dark:border-white/10 pt-5">
            <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
              {t("settings.telegram.title")}
            </div>

            <Field label={t("settings.telegram.token")} hint={t("settings.telegram.token_hint")}>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={tgToken}
                  onChange={(e) => {
                    setTgToken(e.target.value);
                    setTgBotInfo(null);
                    setTgTokenError(null);
                  }}
                  placeholder="123456:ABC-..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button size="sm" variant="ghost" onClick={validateTelegramToken}>
                  {t("settings.telegram.check")}
                </Button>
              </div>
              {tgBotInfo && (
                <span className="text-[11px] text-green-600 dark:text-green-400">
                  {t("settings.telegram.token_valid")}: @
                  {tgBotInfo.username ?? tgBotInfo.first_name ?? "bot"}
                </span>
              )}
              {tgTokenError && (
                <span className="text-[11px] text-red-500">
                  {t("settings.telegram.token_invalid")}: {tgTokenError}
                </span>
              )}
            </Field>

            {tgBotInfo && (
              <div className="mt-3 flex items-center gap-3">
                <Button size="sm" variant="ghost" onClick={pickTelegramChat} disabled={tgListening}>
                  {tgChatId
                    ? t("settings.telegram.reassign_chat")
                    : t("settings.telegram.pick_chat")}
                </Button>
                {tgListening && (
                  <span className="text-[11px] text-neutral-500 flex items-center gap-1.5">
                    <Spinner /> {t("settings.telegram.waiting_start")}
                  </span>
                )}
                {!tgListening && tgChatId && (
                  <span className="text-[11px] text-green-600 dark:text-green-400">
                    {t("settings.telegram.chat_saved")}: {tgChatLabel || tgChatId}
                  </span>
                )}
                {!tgListening && tgListenError && (
                  <span className="text-[11px] text-red-500">{tgListenError}</span>
                )}
              </div>
            )}

            <div className="mt-4 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={tgEventsEnabled}
                  onChange={(e) => setTelegramEventsEnabled(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-blue-500"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{t("settings.telegram.events_enabled")}</div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">
                    {t("settings.telegram.events_enabled_hint")}
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={tgFilesEnabled}
                  onChange={(e) => setTelegramFilesEnabled(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-blue-500"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{t("settings.telegram.files_enabled")}</div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">
                    {t("settings.telegram.files_enabled_hint")}
                  </div>
                </div>
              </label>
            </div>
          </div>
        </div>
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

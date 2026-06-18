import { useState } from "react";
import { useTranslation } from "react-i18next";
import Sidebar, { Section } from "./components/Sidebar";
import Servers from "./views/Servers";
import ServerDetail from "./views/ServerDetail";
import Datasets from "./views/Datasets";
import Training from "./views/Training";
import Settings from "./views/Settings";

type Route =
  | { kind: "list" }
  | { kind: "detail"; id: string };

/** Целевая «куда открыть» — навигация по клику на бадж в списке серверов. */
export interface TrainingTarget {
  project: string;
  pod: string;
  /** Уникальный nonce, чтобы Training.tsx срабатывал даже если выбраны те же значения. */
  nonce: number;
}

export default function App() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("servers");
  const [serversRoute, setServersRoute] = useState<Route>({ kind: "list" });
  const [trainingTarget, setTrainingTarget] = useState<TrainingTarget | null>(null);

  function go(s: Section) {
    setSection(s);
    if (s === "servers") setServersRoute({ kind: "list" });
  }

  function goTraining(project: string, pod: string) {
    setTrainingTarget({ project, pod, nonce: Date.now() });
    setSection("training");
  }

  return (
    <div className="app-shell flex h-full w-full relative">
      <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-50" />
      <Sidebar current={section} onChange={go} />
      <main className="flex-1 overflow-auto">
        <header
          data-tauri-drag-region
          className="sticky top-0 z-10 backdrop-blur-xl bg-white/40 dark:bg-black/30 border-b border-black/[0.06] dark:border-white/10 px-8 pt-7 pb-4 select-none cursor-default"
        >
          <h1 data-tauri-drag-region className="text-base font-semibold tracking-tight">
            {t("app.title")}
          </h1>
        </header>
        <div className="p-8">
          {section === "servers" && serversRoute.kind === "list" && (
            <Servers
              onOpen={(id) => setServersRoute({ kind: "detail", id })}
              onOpenSettings={() => go("settings")}
              onOpenTraining={goTraining}
            />
          )}
          {section === "servers" && serversRoute.kind === "detail" && (
            <ServerDetail
              podId={serversRoute.id}
              onBack={() => setServersRoute({ kind: "list" })}
            />
          )}
          {section === "datasets" && (
            <Datasets onGoTraining={() => setSection("training")} />
          )}
          {section === "training" && <Training target={trainingTarget} />}
          {section === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}

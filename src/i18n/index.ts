import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import ru from "./ru.json";

const stored = typeof localStorage !== "undefined" ? localStorage.getItem("lang") : null;
const fallback = (navigator.language || "en").toLowerCase().startsWith("ru") ? "ru" : "en";

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ru: { translation: ru } },
  lng: stored || fallback,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLang(lng: "en" | "ru") {
  i18n.changeLanguage(lng);
  localStorage.setItem("lang", lng);
}

export default i18n;

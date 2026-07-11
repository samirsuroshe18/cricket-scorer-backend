import i18next from "i18next";
import Backend from "i18next-fs-backend";

await i18next
    .use(Backend)
    .init({
        fallbackLng: "en",
        preload: ["en", "hi", "mr"],
        ns: ["common"],
        defaultNS: "common",
        // debug: process.env.NODE_ENV !== "production",

        backend: {
            loadPath: "./src/locales/{{lng}}/{{ns}}.json"
        },

        interpolation: {
            escapeValue: false // not rendering into HTML, so no need to escape
        }
    });

export default i18next;
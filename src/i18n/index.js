import { createI18n } from 'vue-i18n'
import de from './locales/de.json'
import en from './locales/en.json'
import es from './locales/es.json'

const i18n = createI18n({
    legacy: false,
    locale: localStorage.getItem('locale') || 'de',
    fallbackLocale: 'en',
    messages: {
        de,
        en,
        es
    }
})

export default i18n

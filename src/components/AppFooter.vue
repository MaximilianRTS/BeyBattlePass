<template>
  <footer class="app-footer" role="contentinfo">
    <div class="footer-inner">

      <!-- Left: Branding + License -->
      <div class="footer-brand">
        <span class="footer-logo-text">⚡ Bey Battle Pass</span>
        <span class="footer-separator" aria-hidden="true">·</span>
        <a
          href="https://github.com/MaximilianRTS/BeyBattlePass/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
          class="footer-license"
          :title="t('footer.license_title')"
        >
          MIT License
        </a>
      </div>

      <!-- Center: Open Source Badge -->
      <div class="footer-center">
        <a
          href="https://github.com/MaximilianRTS/BeyBattlePass"
          target="_blank"
          rel="noopener noreferrer"
          class="footer-github-btn"
          :aria-label="t('footer.github_aria')"
        >
          <!-- GitHub SVG Icon -->
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
          </svg>
          <span>{{ t('footer.open_source') }}</span>
        </a>
      </div>

      <!-- Right: Language Switcher -->
      <div class="footer-right">
        <span class="footer-lang-label" aria-hidden="true">🌐</span>
        <div class="lang-switcher" role="group" :aria-label="t('footer.language_label')">
          <button
            v-for="lang in languages"
            :key="lang.code"
            class="lang-btn"
            :class="{ active: locale === lang.code }"
            :aria-pressed="locale === lang.code"
            :title="lang.label"
            @click="setLocale(lang.code)"
          >
            {{ lang.flag }} {{ lang.code.toUpperCase() }}
          </button>
        </div>
      </div>

    </div>

    <!-- Bottom Row: Version + Link -->
    <div class="footer-bottom">
      <span class="footer-version">v{{ appVersion }}</span>
      <span class="footer-separator" aria-hidden="true">·</span>
      <span class="footer-made-with">{{ t('footer.made_with') }}</span>
      <span class="footer-separator" aria-hidden="true">·</span>
      <a
        href="https://github.com/MaximilianRTS/BeyBattlePass/issues"
        target="_blank"
        rel="noopener noreferrer"
        class="footer-link"
      >
        {{ t('footer.report_issue') }}
      </a>
    </div>
  </footer>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

const appVersion = '1.0.0'

const languages = [
  { code: 'de', flag: '🇩🇪', label: 'Deutsch' },
  { code: 'en', flag: '🇬🇧', label: 'English' },
  { code: 'es', flag: '🇪🇸', label: 'Español' },
]

const setLocale = (code) => {
  locale.value = code
  localStorage.setItem('locale', code)
}
</script>

<style scoped>
.app-footer {
  border-top: 1px solid var(--color-border);
  background: var(--color-background-soft);
  padding: var(--spacing-sm) var(--spacing-xl);
  margin-top: auto;
}

.footer-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  flex-wrap: wrap;
  max-width: 1400px;
  margin: 0 auto;
  padding: var(--spacing-sm) 0;
}

/* --- Brand --- */
.footer-brand {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 0.85rem;
  color: var(--color-text-muted);
}

.footer-logo-text {
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.02em;
}

.footer-license {
  color: var(--color-text-muted);
  font-size: 0.8rem;
  transition: color var(--transition-fast);
}

.footer-license:hover {
  color: var(--color-primary);
}

.footer-separator {
  color: var(--color-text-muted);
  opacity: 0.4;
}

/* --- GitHub Button (Center) --- */
.footer-center {
  display: flex;
  align-items: center;
}

.footer-github-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 0.35rem 0.85rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text-muted);
  font-size: 0.82rem;
  font-weight: 500;
  text-decoration: none;
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast);
}

.footer-github-btn:hover {
  background: rgba(100, 108, 255, 0.12);
  border-color: var(--color-primary);
  color: var(--color-primary);
  transform: translateY(-1px);
}

/* --- Language Switcher --- */
.footer-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.footer-lang-label {
  font-size: 0.9rem;
}

.lang-switcher {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--color-background-mute);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  padding: 2px;
}

.lang-btn {
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.78rem;
  font-weight: 500;
  padding: 0.25rem 0.6rem;
  border-radius: var(--radius-full);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
  font-family: inherit;
  letter-spacing: 0.03em;
}

.lang-btn:hover:not(.active) {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
}

.lang-btn.active {
  background: var(--color-primary);
  color: #fff;
  font-weight: 600;
}

/* --- Bottom Row --- */
.footer-bottom {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding-top: var(--spacing-xs);
  font-size: 0.75rem;
  color: var(--color-text-muted);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  max-width: 1400px;
  margin: 0 auto;
  opacity: 0.7;
}

.footer-version {
  font-family: monospace;
  font-size: 0.72rem;
  opacity: 0.7;
}

.footer-link {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  transition: color var(--transition-fast);
}

.footer-link:hover {
  color: var(--color-primary);
}

/* --- Responsive --- */
@media (max-width: 640px) {
  .footer-inner {
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--spacing-sm);
  }

  .footer-brand {
    justify-content: center;
  }
}
</style>

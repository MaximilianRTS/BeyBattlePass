# Contributing to BeyBattlePass

Thank you for your interest in contributing! 🎉  
BeyBattlePass is an open source project and we welcome contributions of all kinds.

---

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Adding Translations](#adding-translations)

---

## 🤝 Code of Conduct

Please be respectful and constructive. We want this to be a welcoming community for everyone.

---

## 🛠️ How to Contribute

### Development Setup

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/BeyBattlePass.git
cd BeyBattlePass

# 3. Install dependencies
npm install

# 4. Start the dev server
npm run dev
```

The app runs at `http://localhost:5173`.

### Project Structure

| Folder / File | Purpose |
|---------------|---------|
| `src/components/Workspace.vue` | Core editor (preview, sliders, export logic) |
| `src/components/AppFooter.vue` | Footer with language switcher & GitHub link |
| `src/views/EditorView.vue` | Main page layout |
| `src/i18n/locales/` | Translation files (DE, EN) |
| `src/utils/imageProcessing.js` | Image manipulation utilities |
| `src/utils/storage.js` | IndexedDB persistence |

---

## 🔀 Submitting a Pull Request

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** – keep them focused and minimal.

3. **Follow the code style:**
   - Use `const` over `let`, never `var`
   - Arrow functions preferred
   - Template literals instead of string concatenation
   - `===` for equality checks
   - No `console.log` in production code

4. **Test your changes** in the browser before submitting.

5. **Write a clear commit message:**
   ```
   feat: add French translation
   fix: correct PDF scaling on mobile
   docs: update README with new screenshots
   ```

6. **Push and open a Pull Request** against `main`.

---

## 🐛 Reporting Bugs

Please [open an issue](https://github.com/MaximilianRTS/BeyBattlePass/issues/new) and include:

- **What happened** (describe the bug)
- **How to reproduce it** (steps)
- **Expected behavior**
- **Screenshots** if applicable
- **Browser & OS** (e.g. Chrome 121 on Windows 11)

---

## 💡 Suggesting Features

Have an idea? [Open a feature request](https://github.com/MaximilianRTS/BeyBattlePass/issues/new) and describe:

- **What problem** does this feature solve?
- **How would it work** from a user's perspective?

---

## 🌍 Adding Translations

Want to add a new language? It's easy:

1. Copy `src/i18n/locales/en.json` to `src/i18n/locales/[code].json`  
   (e.g. `fr.json` for French)
2. Translate all values (keep the keys as-is)
3. Register the language in `src/i18n/index.js`:
   ```js
   import fr from './locales/fr.json'

   const i18n = createI18n({
     messages: { de, en, fr }  // add your language here
   })
   ```
4. Add a button for it in `src/components/AppFooter.vue`:
   ```js
   const languages = [
     { code: 'de', flag: '🇩🇪', label: 'Deutsch' },
     { code: 'en', flag: '🇬🇧', label: 'English' },
     { code: 'fr', flag: '🇫🇷', label: 'Français' }, // add here
   ]
   ```

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
